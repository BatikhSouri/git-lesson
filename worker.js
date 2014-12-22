var crypto = require('crypto');
var config = require('./config.json');

var dbmodels = require('./dbmodels');
var mongoose = require('mongoose');
var User = mongoose.model('User');
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
			console.error('Task cannot be pasred');
			redis.rpush('failed' + config.redis.tasksList, nextTaskRaw);
			return;
		}
		if (nextTask.type == 'userRepos'){

		} else if (nextTask.type == 'hook'){
			var ownerId = nextTask.ownerId;
			var repoId = nextTask.repoId;

		} else {
			console.error('Unknown task type: ' + nextTaskRaw);
			redis.rpush('failed' + config.redis.tasksList, nextTaskRaw);
		}
	});
}

function hookForRepo(repoId, callback){
	Hook.count({repoId: repoId}, callback);
}

function allReposForUser(userId, callback){
	User.findOne({id: userId}, function(err, existingUser){
		if (err){
			callback(err);
			return;
		}
		var foundRepoIds = [];
		if (existingUser){
			var uClient = new githubApi({version: '3.0.0'});
			uClient.authenticate({
				type: 'oauth',
				token: existingUser.token
			});
			uClient.user.get(function(err, currentUserProfile){
				if (err) {
					callback(err);
					return;
				}
				var currentUsername = currentUserProfile.login;
				uClient.repos.getFromUser({user: currentUsername}, callback);
			})
		} else {
			//Getting all repos for a given user will be then used to setup hooks for that user.
			//If user cannot be found in DB, that means we don't have the token to setup hooks for him
			//Abort with empty callback
			callback();
		}
	});
}

function scheduleRepos(client, user, reposList, cb){

	var currentRepoIndex = 0;
	var stackCount = 0;

	//Trying to process linearly-async, without letting the callstack grow indefinitely
	function processOne(){
		stackCount++;
		if (stackCount == 1000){
			setTimeout(function(){
				scheduleForRepo(client, user, reposList[currentRepoIndex], function(err){
					if (err){
						console.error('Error while setting up a hook for repo ' + user + '/' + reposList[i].name + ':' + err);
						return;
					}
					currentRepoIndex++;
					if (currentRepoIndex == reposList.length) cb();
					else processOne();
				});
			}, 0);
			stackCount = 0;
		} else {
			scheduleForRepo(client, user, reposList[currentRepoIndex], function(err){
				if (err){
					console.error('Error while setting up a hook for repo ' + user + '/' + reposList[i].name + ':' + err);
					return;
				}
				currentRepoIndex++;
				if (currentRepoIndex == reposList.length) cb();
				else processOne();
			});
		}
	}
	processOne();

	function scheduleForRepo(client, user, repoObj, cb){
		client.repos.getHooks({user: user, repo: repoObj.name}, function(err, currentHooks){
			if (err){
				cb(err);
				return;
			}
			var gitLessonEnabled = false;
			for (var i = 0; i < currentHooks.length; i++){
				if (currentHooks[i].config.url == config.github.hookUrl){
					gitLessonEnabled = true;
					return;
				}
			}
			if (!gitLessonEnabled){
				var hookSecret = crypto.pseudoRandomBytes(6).toString('base64');
				var hookConfig = {
					url: config.github.hookUrl,
					content_type: 'application/json',
					secret: hookSecret
				};
				client.repos.createHook({
					user: user,
					repo: repoObj.name,
					name: config.github.hookName,
					config: hookConfig,
					events: ['push'],
					active: true
				}, function(err, res){
					if (err){
						cb(err);
						return;
					}
					var newHook = new Hook({
						repoId: repoObj.id,
						url: repoObj.html_url,
						secret: hookSecret
					});
					newHook.save(cb);
				});
			} else cb();
		});
	}
}

function getUnsetRepos(reposList, cb){

	var currentIndex = 0;
	var stackCount = 0;
	var unsetRepos = [];

	//Trying to process linearly-async, without letting the callstack grow indefinitely
	function processOne(){
		stackCount++;
		if (stackCount == 1000){
			setTimeout(function(){
				Hook.findOne({repoId: reposList[currentIndex].id}, function(err, setRepo){
					if (err){
						cb(err);
						return;
					}
					if (!setRepo) unsetRepos.push(reposList[currentIndex]);
					currentIndex++;
					if (currentIndex == reposList.length) cb(null, unsetRepos);
					else processOne();
				});
			}, 0);
			stackCount = 0;
		} else {
			Hook.findOne({repoId: reposList[currentIndex].id}, function(err, setRepo){
				if (err){
					cb(err);
					return;
				}
				if (!setRepo) unsetRepos.push(reposList[currentIndex]);
				currentIndex++;
				if (currentIndex == reposList.length) cb(null, unsetRepos);
				else processOne();
			});
		}
	}

}
