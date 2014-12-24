var crypto = require('crypto');
var config = require('./config.json');
var numCpus = require('os').cpus().length;

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

var processIntervals = [];
var concurrentTasks = 0;
var maxConcurrentTasks = numCpus * config.github.workersPerCpu;

exports.start = function(){
	for (var i = 0; i < config.github.workersPerCpu; i++){
		processIntervals.push(setInterval(processCycle, config.github.workInterval));
	}

};

exports.stop = function(){
	while (processIntervals.length > 0){
		clearInterval(processIntervals[0]);
		processIntervals.splice(0, 1);
	}
};

function processCycle(){
	redis.llen(config.redis.tasksList, function(err, numWaitingTasks){
		if (err){
			console.error('Error while getting the task queue length: ' + err);
			return;
		}
		if (numWaitingTasks == 0){
			//No task to be processed
			//Nothing to be done here
		} else {
			//Do not allow more than maxConcurrentTasks
			if (concurrentTasks >= maxConcurrentTasks) return;
			concurrentTasks++;
			processTask(function(){
				concurrentTasks--;
			});
		}
	});
}

function processTask(callback){
	redis.lpop(config.redis.tasksList, function(err, nextTaskRaw){
		if (err){
			console.error('Error while getting next task from redis: ' + err);
			return;
		}
		//No task received
		if (!nextTaskRaw || nextTaskRaw.length == 0){
			callback();
			return;
		}
		var nextTask;
		try {
			nextTask = JSON.parse(nextTaskRaw);
		} catch (e){
			console.error('Task cannot be pasred');
			redis.rpush('failed' + config.redis.tasksList, nextTaskRaw);
			callback();
			return;
		}
		if (nextTask.type == 'userRepos'){
			allReposForUser(nextTask.userId, function(err, userRepos){
				if (err){
					console.error('User\'s repo setup cannot be processed (repos cannot be fetched):\n' + err);
					redis.rpush('failed' + config.redis.tasksList, nextTaskRaw);
					callback();
					return;
				}
				if (userRepos && userRepos.length > 0){
					getUnsetRepos(userRepos, function(err, reposToBeSetup){
						if (err){
							console.error('Error while getting unset repos for user ' + nextTask.userId + ':\n' + err);
							redis.rpush('failed' + config.redis.tasksList, nextTaskRaw);
							callback();
							return;
						}
						if (reposToBeSetup && reposToBeSetup.length > 0){
							for (var i = 0; i < reposToBeSetup.length; i++){
								redis.rpush(config.redis.tasksList, {ownerId: nextTask.userId, repoName: reposToBeSetup[i].name, type: 'hook', newUser: nextTask.newUser});
							}
						}
						callback();
					});
				} else callback();
			});
		} else if (nextTask.type == 'hook'){
			var ownerId = nextTask.ownerId;
			User.findOne({id: ownerId}, function(err, repoOwner){
				if (err){

					callback();
					return;
				}
				if (!repoOwner){

					callback();
					return;
				}
				var ownerName = repoOwner.username;
				var repoName = nextTask.repoName;
				scheduleForRepo(repoOwner, repoName, function(err){
					if (err){
						console.error('Error while setting up hook for ' + ownerName + '/' + repoName + ':' + err);
						redis.rpush('failed' + config.redis.tasksList, nextTaskRaw);
						callback();
						return;
					}
					//Once that the hook is setup, schedule task to search for lessons through previous commits, if the user is not a new one!
					if (!nextTask.newUser){
						redis.rpush(config.redis.tasksList, {ownerName: repoOwner.username, ownerToken: repoOwner.token, repoName: repoName, type: 'commitSearch'});
					}
					callback();
				});
			});
		} else if (nextTask.type == 'commitSearch'){
			var ownerName = nextTask.ownerName;
			var repoName = nextTask.repoName;
			var cClient = ghClientForToken(nextTas.ownerToken);
			var reqOptions = {
				user: ownerName,
				repo: repoName,
				headers: config.github.headers,
				until: Date(),
				per_page: 100
			}
		} else {
			console.error('Unknown task type: ' + nextTaskRaw);
			redis.rpush('failed' + config.redis.tasksList, nextTaskRaw);
			callback();
			return;
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
				uClient.repos.getFromUser({headers: config.github.headers, user: currentUsername}, callback);
			})
		} else {
			//Getting all repos for a given user will be then used to setup hooks for that user.
			//If user cannot be found in DB, that means we don't have the token to setup hooks for him
			//Abort with empty callback
			callback();
		}
	});
}

/*function scheduleRepos(client, user, reposList, cb){

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
}*/

function scheduleForRepo(storedUserObj, repoObj, cb){
	var client = ghClientForToken(storedUserObj.token);
	client.repos.getHooks({user: storedUserObj.username, repo: repoObj.name}, function(err, currentHooks){
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
				headers: config.github.headers,
				user: storedUserObj.username,
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
					ownerId: storedUserObj.id,
					repoId: repoObj.id,
					url: repoObj.html_url,
					secret: hookSecret
				});
				newHook.save(cb);
			});
		} else cb();
	});
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

function ghClientForToken(t){
	var c = new githubApi({version: '3.0.0'});
	c.authenticate({type: 'oauth', token: t});
	return c;
}
