var crypto = require('crypto');
var Buffer = require('buffer').Buffer;
var config = require('../config.json');
var mongoose = require('mongoose');
var redis = require('redis').createClient(config.redis.port, config.redis.host);
var dbmodels = require('../dbmodels');
var User = mongoose.model('User');
var Lesson = mongoose.model('Lesson');
var Hook = mongoose.model('Hook');
var https = require('https');
var githubApi = require('github');
var githubApp = new githubApi({
    version: '3.0.0'
});
githubApp.authenticate({
    type: 'oauth',
    key: config.github.clientId,
    secret: config.github.clientSecret
});

var addDelayedTask = function(){};

var pageDownSanitizer = require('pagedown/Markdown.Sanitizer').getSanitizingConverter();

var accessTokenPath = '/login/oauth/access_token?client_id=' + config.github.clientId + '&client_secret=' + config.github.clientSecret
var requiredScopes = arrayUnique(config.github.requiredScopes.split(/,/g));

/* GET home page. */
exports.index = function(req, res){
    var tips = [];
    var renderOptions = {title: 'Home'};

    handleSession(req, res, renderOptions, function(){
        if (req.query.newUser) renderOptions.newUser = true;
        else if (!req.session.id && req.query.logout) renderOptions.logout = true;
        getLatestLessons();
    })

    function getLatestLessons(){
        getLessons(null, null, null, null, function(err, fetchedLessons){
            tips = fetchedLessons;
            renderCb();
        });
    }

    function renderCb(){
        if (tips.length > 0) renderOptions.tips = tips;
        res.render('index', renderOptions);
    }
};

exports.login = function(req, res){

    if (!req.query.code){
        res.redirect('https://github.com/login/oauth/authorize?client_id=' + config.github.clientId + '&scope=' + config.github.askedScopes);
        return;
    }
    var tokenReq = https.request({
        host: 'github.com',
        path: accessTokenPath + '&code=' + req.query.code,
        headers: {'Accept': 'application/json'},
        method: 'POST'
    }, function(ghRes){
        var ghResBody = '';
        ghRes.setEncoding('utf8');
        ghRes.on('data', function(chunk){
            ghResBody += chunk
        });
        ghRes.on('end', function(){
            var parsedGhRes;
            try {
                parsedGhRes = JSON.parse(ghResBody);
            } catch (e){
                res.render('error', {title: 'Authentication error', message: 'Error in GitHub authentication process. Sorry for that', homeButton: true});
                console.error('Error while parsing github\'s access_token response:\n' + ghResBody + '\nError: ' + e);
                return;
            }
            if (parsedGhRes.error){
                res.render('error', {title: 'Authentication error', message: 'Error in GitHub authentication process. Sorry for that', homeButton: true});
                console.error('Auth error:\n' + JSON.stringify(parsedGhRes));
                return;
            }
            //console.log(parsedGhRes.access_token && parsedGhRes.scope);
            if (!(parsedGhRes.access_token && parsedGhRes.scope)){
                res.render('error', {title: 'Authentication error', message: 'Error in GitHub authentication process. Sorry for that', homeButton: true});
                console.error('Error while parsing github\'s access_token response:\nmissing token and/or scope properties:\nReceived response:\n' + JSON.stringify(parsedGhRes));
                return;
            }
            var receivedScopes = parsedGhRes.scope.split(/,/g);
            var missingScopes = checkRequiredScopeIntegrity(receivedScopes);
            if (missingScopes.length > 0){
                res.render('error', {title: 'Login error', message: 'Missing github authorizations: ' + missingScopes.join(', ')});
                return;
            }
            var ghUserClient = ghClientForToken(parsedGhRes.access_token);
            getUserProfile(ghUserClient, function(err, data){
                if (err){
                    res.render('error', {title: 'Authentication error', message: 'Error while creating your account. Sorry for that', homeButton: true});
                    console.error('err: ' + JSON.stringify(err));
                } else {
                    //Check whether the user already exist
                    User.count({id: data.id}, function(err, existingUser){
                        if (err){
                            console.error('Error while checking if user ' + data.id + ' exists in DB: ' + err);
                            res.render('error', {title: 'Authentication error', message: 'Error in GitHub authentication process. Sorry for that', homeButton: true});
                            return;
                        }
                        if (existingUser > 0){
                            User.update({id: data.id}, {username: data.login, token: parsedGhRes.access_token, code: req.query.code, avatarUrl: data.avatar_url}, function(err){
                                if (err){
                                    res.render('error', {title: 'Authentication error', message: 'Error in GitHub authentication process. Sorry for that', homeButton: true});
                                    console.error('Error while updating existing user ' + data.id + ': ' + err);
                                    return;
                                }
                                //Create session
                                var sessionId = createSession(data.id);
                                req.session.id = sessionId;
                                res.redirect('/');
                            });
                        } else {
                            var newUser = new User({
                                id: data.id,
                                username: data.login,
                                token: parsedGhRes.access_token,
                                code: req.query.code,
                                avatarUrl: data.avatar_url
                            });
                            newUser.save(function(err){
                                if (err){
                                    res.render('error', {title: 'Account error', message: 'Error while creating your account. Sorry for that. Please retry later', homeButton: true});
                                    console.error('Error while saving account for userId ' + data.id + ': ' + err);
                                    return;
                                }
                                redis.rpush(config.redis.tasksList, JSON.stringify({type: 'userRepos', userId: data.id, newUser: true}));
                                res.redirect('/?newUser=true');
                            });
                        }
                    });
                }
            });
        });
    });
    tokenReq.on('error', function(err){
        console.error('Error while getting token for code ' + req.query.code + '\n' + err);
        res.render('error', {title: 'Connection error', message: 'Error while contacting github. Sorry for that', homeButton: true});
    });
    tokenReq.end();
};

exports.logout = function(req, res){
    console.log('req.session: ' + JSON.stringify(req.session));
    if (req.session.id){
        deleteSession(req.session.id);
        req.session = null;
    }
    res.redirect('/?logout=true');
};

exports.latestLessons = function(req, res){
    var renderOptions = {title: 'Latest lessons'};

    handleSession(req, res, renderOptions, renderPage);

    function renderPage(){
        getLessons(null, null, null, null, function(err, fetchedLessons){
            if (err) res.render('error', {title: 'Error', message: 'An internal error occured. Sorry for that'});
            else {
                renderOptions.tips = fetchedLessons;
                res.render('lessonsview', renderOptions);
            }
        });
    }
};

exports.showLesson = function(req, res){
    var renderOptions = {};

    handleSession(req, res, renderOptions, renderPage);

    function renderPage(){
        var lessonId = req.param('id');
        Lesson.findOne({id: lessonId}, function(err, requestedLesson){
            if (err){
                res.send(500, 'Internal error');
                console.error('Error while rendering lesson page for lessonId ' + lessonId + ':\n' + err);
                return;
            }
            if (requestedLesson){
                Hook.findOne({repoId: requestedLesson.repoId}, function(err, sourceRepo){
                    if (err){
                        res.send(500, 'Internal error');
                        console.error('Error while getting the source repo for lessonId ' + lessonId + ':\n' + err);
                        return;
                    }
                    renderOptions.title = requestedLesson.title || 'Lesson';
                    renderOptions.lesson = requestedLesson;
                    renderOptions.repo = sourceRepo
                    User.findOne({id: requestedLesson.author}, function(err, lessonAuthor){
                        if (err){
                            res.send(500, 'Internal error');
                            console.error('Error while getting the author for lessonId ' + lessonId + ':\n' + err);
                            return;
                        }
                        renderOptions.author = lessonAuthor;
                        res.render('lesson', renderOptions);
                    });
                });
            } else {
                renderOptions.title = 'Lesson not found';
                renderOptions.message = 'The lesson you requested cannot be found';
                res.render('error', renderOptions, function(err, html){
                    if (err) res.send(404, 'The lesson you requested cannot be found');
                    else res.send(404, html);
                });;
            }
        });
    }
};

exports.showUserProfile = function(req, res){
    var renderOptions = {};
    handleSession(req, res, renderOptions, function(){
        var requestedUsername = req.param('username');
        User.findOne({username: requestedUsername}, function(err, requestedUser){
            if (err){
                res.render('error', {title: 'Internal error', message: 'Sorry for the inconvenience'});
                console.error('Error while getting profile of user ' + err);
                return;
            }
            if (!requestedUser){
                res.render('error', {title: 'Cannot be found', message: '@' + requestedUsername + ' cannot be found'});
                return;
            }
            renderOptions.profile = requestedUser;
            getLessons({author: requestedUser.id}, null, null, null, function(err, postedLessons){
                renderOptions.postedLessons = postedLessons;
                res.render('userprofile', renderOptions);
            });
        });
    });
};

exports.searchJson = function(req, res){
    var query = req.query.q;
    var altQuery = query.replace(/ +/g, '|');
    var searchRegex = new RegExp(altQuery, 'gi');

    var tagsResults, titleResults, contentResults;

    Lesson.find({tags: searchRegex}, function(err, lessonsByTags){
        if (err){
            console.error('Error while searching lessons by tag. Query: ' + altQuery + ' Error:\n' + err);
        }
        tagsResults = lessonsByTags;
        endCb();
    });

    Lesson.find({title: searchRegex}, function(err, lessonsByTitle){
        if (err){
            console.error('Error while searching lessons by title. Query: ' + altQuery + ' Error:\n' + err);
        }
        titleResults = lessonsByTitle;
        endCb();
    });

    Lesson.find({postHtml: searchRegex}, function(err, lessonsByContent){
        if (err){
            console.error('Error while searching lessons by content. Query: ' + altQuery + ' Error:\n' + err);
        }
        contentResults = lessonsByContent;
        endCb();
    })

    var endCounter = 0;
    function endCb(){
        endCounter++;
        if (endCounter == 3) mergeAndSortResults();
    }

    function mergeAndSortResults(){

    }
}

exports.manual = function(req, res){
    var renderOptions = {title: 'Manual'};
    handleSession(req, res, renderOptions, function(){
        res.render('howtoview', renderOptions);
    });
};

exports.faq = function(req, res){
    var renderOptions = {title: 'FAQ'};
    handleSession(req, res, renderOptions, function(){
        res.render('faqview', renderOptions);
    });
};

exports.hook = function(req, res){
    if (!(req.headers['x-github-event'] && req.headers['x-hub-signature'])){
        res.send(400, 'Invalid headers');
        return;
    }
    if (req.headers['x-github-event'].toLowerCase() != 'push'){
        res.send(200, 'Unsupported hook event');
        return;
    }
    var payload = JSON.parse(req.body.payload);
    if (!(payload.repository && payload.repository.id)){
        res.send(400, 'Missing repository id field');
        return
    }
    Hook.findOne({repoId: payload.repository.id}, function(err, foundHook){
        if (err){
            res.send(500, 'Internal error');
            return;
        }
        if (foundHook){
            var hmac = crypto.createHmac('sha1', new Buffer(foundHook.secret));
            hmac.update(new Buffer(req.rawReqBody));
            var h = hmac.digest('hex');
            if ('sha1=' + h.toLowerCase() != req.headers['x-hub-signature'].toLowerCase()){
                //Invalid github signature
                res.send(401, 'Invalid HMAC signature');
                return;
            }
            processHook(foundHook);
        } else {
            res.send(400, 'Unregistered hook');
            return;
        }
    });

    function processHook(h){
        var endCount = 0;
        var head = payload.ref;
        //Only add lessons that are sourced from the master branch
        if (head != 'refs/heads/master'){
            res.send(200, 'Webhook payload received and processed');
            return;
        }
        var commits = payload.commits;
        var repo = payload.repository;
        if (payload.forced){
            //Look for previous lessons in the DB. Needing the hash of the parent commit
            handleForcedPush(function(err){
                if (err){
                    console.log('error while handling previous/overlapping lessons: ' + err);
                    res.send(500, 'Internal error');
                    return;
                }
                processCommitMessages();
            });
        } else processCommitMessages();

        function processCommitMessages(){
            for (var i = 0; i < commits.length; i++){
                var parsedLesson = parseLesson(commits[i].message);
                if (parsedLesson){
                    parsedLesson.lang = parsedLesson.lang || repo.language;
                    parsedLesson.tags = parsedLesson.tags || [parsedLesson.lang];
                    parsedLesson.id = crypto.pseudoRandomBytes(6).toString('base64');
                    parsedLesson.repoId = repo.id
                    parsedLesson.commitId = commits[i].id
                    if (commits[i].parents && commits[i].parents.length > 0){
                        parsedLesson.parentCommitId = commits[i].parents[0].sha;
                    }
                    parsedLesson.author = payload.sender.id;
                    parsedLesson.postHtml = pageDownSanitizer.makeHtml(parsedLesson.lesson); //Fallback value
                    User.findOne({id: parsedLesson.author}, function(err, authorUser){
                        if (err){
                            console.error('Cannot get lesson\'s author from db: (authorId: ' + parsedLesson.author + '): ' + err);
                            endCb();
                            return;
                        }
                        if (!authorUser){
                            console.error('Author user missing from DB (id: ' + parsedLesson.author + '): ' + err);
                            endCb();
                            return;
                        }
                        renderMd(parsedLesson.lesson, h.ownerName + '/' + h.name, authorUser.token, function(err, renderedMd){
                            if (err){
                                console.error('Error while rendering the markdown for repoId ' + parsedLesson.repoId + ':\n' + err);
                                //endCb();
                                //return;
                            } else {
                                parsedLesson.postHtml = renderedMd;
                            }
                            var newLesson = new Lesson(parsedLesson);
                            newLesson.save(function(err){
                                if (err) {
                                    console.error('Error while saving lesson ' + JSON.stringfy(parsedLesson) + ':' + err);
                                }
                                endCb();
                            });
                        });
                    });
                } else endCb();
            }
        }

        function handleForcedPush(callback){
            var checkCount = 0;
            var foundErr;

            for (var i = 0; i < commits.length; i++){
                var currentCommit = commits[i];
                if (currentCommit.parents && currentCommit.parents.length > 0){
                    Lesson.findOne({parentCommitId: currentCommit.parents[0].sha}, function(err, existingLesson){
                        if (err){
                            foundErr = err;
                            checkCb();
                            return;
                        }
                        if (existingLesson){
                            existingLesson.remove(function(err){
                                if (err){
                                    foundErr = err;
                                }
                                checkCb();
                            });
                        } else checkCb();
                    });
                } else checkCb();
            }

            function checkCb(){
                checkCount++;
                if (checkCount == commits.length) callback(foundErr);
            }
        }

        function endCb(){
            endCount++;
            if (endCount == commits.length){
                res.send(200, 'Webhook payload received and processed');
            }
        }
    }
};

exports.setAddDelayedTask = function(f){
    if (typeof f == 'function') addDelayedTask = f;
};

function ghClientForToken(t){
    var c = new githubApi({version: '3.0.0'});
    c.authenticate({type: 'oauth', token: t});
    return c;
}

function ghClientForId(id, callback){
    User.findOne({id: id}, function(err, u){
        if (err) callback(err);
        else {
            if (!u) callback(null, null);
            else callback(null, ghClientForToken(u.token));
        }
    });
}

function getUserProfile(t, callback){
    var client = (typeof t == 'string' ? ghClientForToken(t) : t);
    client.user.get({headers: config.github.headers}, callback);
}

function getUserEmails(t, callback){
    var client = (typeof t == 'string' ? ghClientForToken(t) : t);
    client.user.getEmails({headers: config.github.headers}, callback);
}

/*
* Sessions management
*/
function createSession(userId, cb){
    var sessionId = crypto.pseudoRandomBytes(8).toString('hex');
    redis.hset(config.redis.sessionsHash, sessionId, userId);
    return sessionId;
}

function checkSession(sessionId, cb){
    redis.hget(config.redis.sessionsHash, sessionId, function(err, userId){
        if (err){
            cb(err);
            return;
        }
        if (!userId){
            cb();
            return;
        }
        User.findOne({id: userId}, cb);
    });
}

function deleteSession(sessionId){
    redis.hdel(config.redis.sessionsHash, sessionId);
}

function handleSession(req, res, renderOptions, callback){
    if (req.session.id){
        checkSession(req.session.id, function(err, connectedUser){
            if (err){
                res.render('error', {title: 'Error', message: 'An internal error happened. Sorry for that'});
                console.error('Error while checking user for session ' + req.session.id + ': ' + err);
                return;
            }
            if (!connectedUser){
                console.log('This session doesn\'t exist: ' + req.session.id);
                req.session = null;
                callback();
                return;
            }
            renderOptions.user = connectedUser;
            callback();
        });
    } else callback();
}
/*
* End of: Sessions management
*/

function getLessons(query, limit, offset, order, callback){
    var lessonsArray = [];

    var dbQuery = Lesson.find(query || {}).sort(order || {postDate: 'desc'}).skip(offset || 0);
    if (!limit) dbQuery = dbQuery.limit(25); //No limit parameter passed -> default limit to 25 elements
    else if (limit > -1) dbQuery = dbQuery.limit(limit); //A limit has been passed and is different / bigger than -1. Apply it
    //implicit else : if limit == -1, then no limit
    dbQuery.exec(function(err, latestLessons){
        if (err){
            console.error('Error while getting the latest lessons: ' + err);
            callback(err, []);
            return;
        }
        if (!(latestLessons && latestLessons.length > 0)){
            callback(undefined, []);
            return;
        }
        var endRetrieval = 0;
        for (var i = 0; i < latestLessons.length; i++){
            retrieveOne(latestLessons[i]);
        }

        function retrieveOne(lesson){
            var currentRepoId = lesson.repoId;
            var currentLessonId = lesson.id;
            Hook.findOne({repoId: currentRepoId}, function(err, sourceRepo){
                if (err){
                    console.error('Error while getting the source repo for lessonId ' + currentLessonId + ': ' + err);
                    lessonsArray.push({lesson: lesson});
                    endCb();
                    return;
                }
                if (!sourceRepo){
                    console.log('Cannot find source repo for lessonId ' + currentLessonId + ': ' + err);
                    lessonsArray.push({lesson: lesson});
                    endCb();
                    return;
                }
                User.findOne({id: lesson.author}, function(err, lessonAuthor){
                    if (err){
                        console.error('Error while getting author for lessonId ' + currentLessonId + ' in repoId ' + sourceRepo.repoId + ': ' + err);
                        lessonsArray.push({lesson: lesson, repo: sourceRepo});
                        endCb();
                        return;
                    }
                    lessonsArray.push({lesson: lesson, repo: sourceRepo, author: lessonAuthor}); //Whether lessonAuthor is defined or not is irrelevant
                    endCb();
                });
            });
        }

        function endCb(){
            endRetrieval++;
            if (endRetrieval == latestLessons.length){
                callback(undefined, lessonsArray);
            }
        }
    });
}

function parseLesson(commitMessage){
    if (typeof commitMessage != 'string') return null;
    var commitMessageLines = commitMessage.split(/\r\n|\n|\r/gm);
    var lessonTagIndex = -1;
    for (var i = 0; i < commitMessageLines.length; i++){
        if (commitMessageLines[i].indexOf('[lesson]') == 0){
            lessonTagIndex = i;
            break;
        }
    }
    if (lessonTagIndex == -1 || lessonTagIndex == commitMessageLines.length - 1) return null;
    var title;
    var tagsLine;
    var langLine, lang;
    var lessonText = '';
    var currentLineIndex = lessonTagIndex + 1;
    if (currentLineIndex >= commitMessageLines.length) return null;

    parseTitle();
    if (currentLineIndex >= commitMessageLines.length) return null;

    parseTags();
    if (currentLineIndex >= commitMessageLines.length) return null;

    parseLang();
    if (currentLineIndex >= commitMessageLines.length) return null;

    for (var i = currentLineIndex; i < commitMessageLines.length; i++){
        lessonText += commitMessageLines[i] + '\r\n';
    }
    return {lesson: lessonText, tags: tagsLine, lang: lang, title: title};

    function parseTitle(){
        if (commitMessageLines[currentLineIndex].indexOf('title=') == 0){
            title = sanitizeHtml(commitMessageLines[currentLineIndex].substring(6));
            currentLineIndex++;
        }
    }

    function parseTags(){
        if (commitMessageLines[currentLineIndex].indexOf('tags=') == 0){
            tagsLine = commitMessageLines[currentLineIndex];
            tagsLine = sanitizeHtml(tagsLine.substring(5));
            currentLineIndex++;
        }
    }

    function parseLang(){
        if (commitMessageLines[currentLineIndex].indexOf('lang=') == 0){
            langLine = commitMessageLines[currentLineIndex];
            lang = sanitizeHtml(langLine.split('=')[1]);
            currentLineIndex++;
        }
    }

    function sanitizeHtml(text){
        text = text.replace('&', '&amp;');
        text = text.replace('\<', '&lt;');
        text = text.replace('>', '&gt;');
        text = text.replace('"', "&quot;");
        text = text.replace('\'', '&#x27;');
        text = text.replace('/', '&#x2F;');
        return text;
    }
}

function renderMd(md, repoFullName, accessToken, callback){
    var o = {text: md, mode: (repoFullName ? 'gfm' : 'markdown'), context: repoFullName};
    var oStr = JSON.stringify(o);
    var reqOptions = {
        host: 'api.github.com',
        method: 'post',
        headers: config.github.headers,
        path: '/markdown?access_token=' + accessToken
    };
    var mdReq = https.request(reqOptions, function(res){
        var accumlatedData = '';
        res.setEncoding('utf8');
        res.on('error', function(err){
            callback(err);
        });
        res.on('data', function(d){
            accumlatedData += d;
        });
        res.on('end', function(){
            callback(null, accumlatedData);
        });
    });
    mdReq.on('error', function(err){
        callback(err);
    })
    mdReq.write(oStr);
    mdReq.end();
}

function getHeadCommit(hookBody, targetHash){
    var headCommit = hookBody.before;
    for (var i = 0; i < hookBody.commits.length; i++){

    }
    return headCommit;
}

function checkRequiredScopeIntegrity(scopeParam){
    var providedScopeArray = (Array.isArray(scopeParam) ? scopeParam : scopeParam.split(/,/g));
    providedScopeArray = arrayUnique(providedScopeArray);
    var missingScopes = [];
    for (var i = 0; i < requiredScopes.length; i++){
        if (binarySearch(providedScopeArray, requiredScopes[i]) == -1) missingScopes.push(requiredScopes[i]);
    }
    return missingScopes;
}

function arrayUnique(a){
    //I've found this ingenious idea here; 2n worst case time complexity:
    //http://www.shamasis.net/2009/09/fast-algorithm-to-find-unique-items-in-javascript-array/
    var h = {}, l = a.length; r = [];
    for (var i = 0; i < l; i++) h[a[i]] = a[i];
    for (e in h) r.push(h[e]);
    return r;
}

function binarySearch(array, item, start, end){
    if (!isSorted(array)) array.sort();
    start = start || 0;
    end = end || array.length - 1;
    if (end < start) return -1;
    var middleElementIndex = start + Math.floor((end-start) / 2);
    if (array[middleElementIndex] < item) return binarySearch(array, item, middleElementIndex + 1, end);
    else if (array[middleElementIndex] > item) return binarySearch(array, item, start, middleElementIndex - 1);
    else return middleElementIndex;
}

function isSorted(a){
    for (var i = 1; i < a.length; i++){
        if (!(a[i] < a[i-1])) return false;
    }
    return true;
}

function mergeObject(o1, o2){
    if (!(typeof o1 == 'object' && typeof o2 == 'object')) throw new TypeError('invalid parameters type');
    var r = {};
    var o1Keys = Object.keys(o1);
    var o2Keys = Object.keys(o2);
    for (var i = 0; i < o1Keys.length; i++) r[o1Keys[i]] = o1[o1Keys[i]];
    for (var i = 0; i < o2Keys.length; i++) r[o2Keys[i]] = o2[o2Keys[i]];
    return r;
}

function mergeObjectArray(objectsArray){
    if (!Array.isArray(objectsArray)) throw new TypeError('objectsArray must be an object');
    var mergedObject = {};
    for (var i = 0; i < objectsArray.length; i++){
        if (typeof objectsArray[i] != 'string') throw new TypeError('item at index ' + i + ' is not an object');
        mergedObject = mergeObject(mergedObject, objectsArray[i]);
    }
    return mergedObject;
}
