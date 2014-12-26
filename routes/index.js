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
                res.render('index', {title: 'git-lesson'});
                return;
            }
            var renderOptions = {title: 'git-lesson', user: connectedUser}
            if (req.query.newUser) renderOptions.newUser = true;
            var tips = [];
            Lesson.find({}).sort({postDate: 'desc'}).limit(25).exec(function(err, latestLessons){
                if (err){
                    console.error('Error while getting the latest lessons: ' + err);
                    renderCb();
                    return;
                }
                if (!(latestLessons && latestLessons.length > 0)){
                    renderCb();
                    return;
                }
                var hooksRetrieved = 0;
                for (var i = 0; i < latestLessons.length; i++){
                    var currentLesson = latestLessons[i];
                    var currentRepoId = currentLesson.repoId;
                    var currentLessonId = currentLesson.id;
                    Hook.findOne({repoId: currentRepoId}, function(err, sourceRepo){
                        hooksRetrieved++;
                        if (err){
                            console.error('Error while getting the source repo for lessonId ' + currentLessonId + ': ' + err);
                            return;
                        }
                        if (!sourceRepo){
                            console.log('Cannot find source repo for lessonId ' + currentLessonId + ': ' + err);
                            return;
                        }
                        tips.push({lesson: currentLesson, repo: sourceRepo});
                        if (hooksRetrieved == latestLessons.length){
                            renderCb();
                        }
                    });
                }
            });

            function renderCb(){
                if (tips.length > 0) renderOptions.tips = tips;
                res.render('index', renderOptions);
            }
        });
    } else res.render('index', {title: "git-lesson"});
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
            console.log(parsedGhRes.access_token && parsedGhRes.scope);
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
    res.redirect('/');
};

exports.showLesson = function(req, res){
    var lessonId = req.param('id');
    Lesson.find({id: lessonId}, function(err, requestedLesson){
        if (err){
            res.send(500, 'Internal error');
            console.error('Error while rendering lesson page for lessonId ' + lessonId + ':\n' + err);
            return;
        }
        if (requestedLesson && requestedLesson._doc){
            res.render('lesson', {title: 'Lesson', lesson: requestedLesson._doc});
        } else {
            res.render('error', {title: 'Lesson not found', message: 'The lesson you requested cannot be found'}, function(err, html){
                if (err) res.send(404, 'The lesson you requested cannot be found');
                else res.send(404, html);
            });
        }
    });
};

exports.hook = function(req, res){
    console.log('Received headers on hook: ' + JSON.stringify(req.headers));
    if (!(req.headers['x-github-event'] && req.headers['x-github-guid'] && req.headers['x-hub-signature'])){
        res.send(400, 'Invalid headers');
        return;
    }
    if (req.headers['x-github-event'].toLowerCase() != 'push'){
        res.send(200, 'Unsupported hook event');
        return;
    }
    if (!(req.body.repository && req.body.repository.id)){
        res.send(400, 'Missing repository id field');
        return
    }
    Hook.find({repoId: req.body.repository.id}, function(err, foundHook){
        if (err){
            res.send(500, 'Internal error');
            return;
        }
        if (foundHook){
            var hmac = crypto.createHmac('sha1', new Buffer(foundHook.secret));
            hmac.update(new Buffer(req.rawBody));
            var h = hmac.digest('hex');
            if ('sha1=' + h.toLowerCase() != req.headers['x-hub-signature'].toLowerCase()){
                //Invalid github signature
                res.send(401, 'Invalid HMAC signature');
                return;
            }
            processHook();
        } else {
            res.send(400, 'Unregistered hook');
            return;
        }
    });

    function processHook(){
        var head = req.body.ref;
        //Only add lessons that are sourced from the master branch
        if (head != 'refs/head/master') return;
        var commits = req.body.commits;
        var repo = req.body.repository;
        for (var i = 0; i < commits.length; i++){
            var parsedLesson = parseLesson(commits[i].message);
            if (parsedLesson){
                parsedLesson.lang = parsedLesson.lang || repo.language;
                parsedLesson.tags = parsedLesson.tags || [parsedLesson.lang];
                parsedLesson.id = crypto.pseudoRandomBytes(6).toString('base64');
                parsedLesson.repoId = repo.id
                parsedLesson.commitId = commits[i].id
                //parsedLesson.parentCommitId = commits[i].
                parsedLesson.author = req.body.sender.id;
                parsedLesson.postHtml = pageDownSanitizer.makeHtml(parsedLesson.lesson);
                var newLesson = new Lesson(parsedLesson);
                newLesson.save(function(err){
                    res.send(500, 'Error while parsing a lesson');
                    return;
                });
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
/*
* End of: Sessions management
*/

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
    var tagsLine;
    var tagsArray = [];
    var langLine, lang;
    var lessonText = '';
    for (var i = lessonTagIndex + 1; i < commitMessageLines.length; i++){
        if (i == lessonTagIndex + 1 && commitMessageLines[i].indexOf('tags=') == 0){
            tagsLine = commitMessageLines[i];
            tagsArray = tagsLine.substring(4).split(/(,| |\+)+/g);
        } else if (i == lessonTagIndex + 2 && commitMessageLines[i].indexOf('lang=') == 0){
            langLine = commitMessageLines[i];
            lang = langLine.subtring(4).split('=')[1];
        } else {
            lessonText += commitMessageLines[i] + '\r\n';
        }
    }
    return {lesson: lessonText, tags: tagsArray, lang: lang};
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
