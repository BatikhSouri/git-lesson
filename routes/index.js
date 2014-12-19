var crypto = require('crypto');
var config = require('../config.json');
var mongoose = require('mongoose');
var dbmodels = require('../dbmodels');
var User = mongoose.model('User');
var Lesson = mongoose.model('Lesson');
var Session = mongoose.model('Session');
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

var accessTokenPath = '/login/oauth/access_token?client_id=' + config.github.clientId + '&client_secret=' + config.github.clientSecret
var requiredScopes = arrayUnique(config.github.requiredScopes.split(/,/g));

/* GET home page. */
exports.index = function(req, res){
    res.render('index', {title: "git-lesson"});
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
                res.send(500, 'Internal error');
                console.error('Error while parsing github\'s access_token response:\n' + ghResBody + '\nError: ' + e);
                return;
            }
            if (!(parsedGhRes.token && parsedGhRes.scope)){
                res.send(500, 'Internal error');
                console.error('Error while parsing github\'s access_token response:\nmissing token and/or scope properties:\nReceived response:\n' + JSON.stringify(parsedGhRes));
                return;
            }
            var receivedScopes = parsedGhRes.scope.split(/,/g);
            var missingScopes = checkRequiredScopeIntegrity(receivedScopes);
            if (missingScopes.length > 0){
                res.render('error', {title: 'Login error', message: 'Missing github authorizations: ' + missingScopes.join(', ')});
                return;
            }
            var ghUserClient = ghClientForToken(parsedGhRes.token);
            getUserProfile(ghUserClient, function(err, data){
                if (err) console.error('err: ' + JSON.stringify(err));
                else {
                    console.log('userProfile data type: ' + typeof data);
                    console.log('userProfile data: ' + JSON.stringify(data));
                }
                //Check whether the user already exist
                //User.findOne({})
            });
        });
    });
    tokenReq.on('error', function(err){
        console.error('Error while getting token for code ' + req.query.code + '\n' + err);
    });
    tokenReq.end();
};

exports.logout = function(req, res){
    console.log('req.session: ' + JSON.stringify(req.session));
    //Session.remove({})
    req.session = null
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
            res.render('lesson', {title: '', lesson: requestedLesson});
        } else {
            res.render('error', {title: 'Lesson not found', message: 'The lesson you requested cannot be found'}, function(err, html){
                if (err) res.send(404, 'The lesson you requested cannot be found');
                else res.send(404, html);
            });
        }
    });
};

exports.hook = function(req, res){
    //if (!(req.body.repository))
};

function ghClientForToken(t){
    var c = new githubApi({version: '3.0.0'});
    c.authenticate({type: 'oauth', token: t});
    return c;
}

function getUserProfile(t, callback){
    var client = (typeof t == 'string' ? ghClientForToken(t) : t);
    client.get(callback);
}

function getUserEmails(t, callback){
    var client = (typeof t == 'string' ? ghClientForToken(t) : t);
    client.getEmails(callback);
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

function checkRequiredScopeIntegrity(scopeParam){
    var providedScopeArray = (Array.isArray(scopeParam) ? scopeParam : scopeParam.split(/,/g));
    providedScopeArray = arrayUnique(providedScopeArray);
    var missingScopes = [];
    for (var i = 0; i < requiredScopes.length; i++){
        if (!binarySearch(providedScopeArray, requiredScopes[i])) missingScopes.push(requiredScopes[i]);
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
    if (end < start) return false;
    var middleElementIndex = start + Math.floor((end-start) / 2);
    if (array[middleElementIndex] < item) return binarySearch(array, item, middleElementIndex + 1, end);
    else if (array[middleElementIndex] > item) return binarySearch(array, item, start, middleElementIndex - 1);
    else return true;
}

function isSorted(a){
    for (var i = 1; i < a.length; i++){
        if (!(a[i] < a[i-1])) return false;
    }
    return true;
}
