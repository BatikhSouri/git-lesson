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

/* GET home page. */
exports.index = function(req, res){

    res.render('index');
};

exports.login = function(req, res){
    res.redirect('https://github.com/login/oauth/authorize?client_id=' + config.github.clientId + '&scope=user:email,public_repo');
};

exports.loginCallback = function(req, res){
    if (!req.query.code){
        res.send(400, 'Missing code');
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

        });
    });
    tokenReq.on('error')
    req.end();
};

exports.logout = function(req, res){

};
accessTokenPathaccess_token
exports.showLesson = function(req, res){

};

exports.hook = function(req, res){

};

function ghClientForToken(t){
    var c = new githubApi({version: '3.0.0'});
    c.authenticate({'oauth', token: t});
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
