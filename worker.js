var crypto = require('crypto');
var config = require('./config.json');

var dbmodels = require('./dbmodels');
var mongoose = require('mongoose');
var Lesson = mongoose.model('Lesson');
var Hook = mongoose.model('Hook');

var redis = require('redis').createClient(config.redis.port, config.redis.host);

var githubApi = require('github');
var gClient = new githubApi({version: '3.0.0'});
gClient.authenticate({
	type: 'oauth',
	key: config.github.clientId,
	secret: config.github.clientSecret
});

function processTask(callback){
	redis.lpop(config.redis.tasksList, function(err, nextTaskRaw){
		if (err){
			console.error('Error while getting next task from redis: ' + err);
			return;
		}
		var nextTask;
		try {
			nextTask = JSON.parse(nextTaskRaw);
		} catch (e){
			console.error('Unknown ')
			return;
		}
		if (nextTask.type == 'userRepos'){

		} else if (nextTask.type == 'hook'){

		} else {
			console.error('Unknown task type: ' + nextTaskRaw);
			redis.rpush('failed' + config.redis.tasksList, nextTaskRaw);
		}
	});
}
