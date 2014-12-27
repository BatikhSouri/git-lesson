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

var pageDownSanitizer = require('pagedown/Markdown.Sanitizer').getSanitizingConverter();

var processIntervals = [];
var schedulingInterval;
var concurrentTasks = 0;
var maxConcurrentTasks = numCpus * config.github.workersPerCpu;

var tasksListName = config.redis.tasksList;
var failedTasksListName = 'failed' + tasksListName;
var delayedTasksListName = 'delayed' + tasksListName;

exports.start = function(callback){
	schedulingInterval = setInterval(pendingTasksSchedulingCycle, config.github.workInterval);

	for (var i = 0; i < config.github.workersPerCpu; i++){
		processIntervals.push(setInterval(processCycle, config.github.workInterval));
	}

	if (typeof callback == 'function') callback();
};

exports.stop = function(callback){
	if (schedulingInterval) clearInterval(schedulingInterval);

	while (processIntervals.length > 0){
		clearInterval(processIntervals[0]);
		processIntervals.splice(0, 1);
	}

	if (typeof callback == 'function') callback();
};

exports.addDelayedTask = addDelayedTask;

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
			redis.rpush(failedTasksListName, nextTaskRaw);
			callback();
			return;
		}
		if (nextTask.type == 'userRepos'){
			allReposForUser(nextTask.userId, function(err, userRepos){
				if (err){
					console.error('User\'s repo setup cannot be processed (repos cannot be fetched):\n' + err);
					redis.rpush(failedTasksListName, nextTaskRaw);
					callback();
					return;
				}
				if (userRepos && userRepos.length > 0){
					getUnsetRepos(userRepos, function(err, reposToBeSetup){
						if (err){
							console.error('Error while getting unset repos for user ' + nextTask.userId + ':\n' + err);
							redis.rpush(failedTasksListName, nextTaskRaw);
							callback();
							return;
						}
						if (reposToBeSetup && reposToBeSetup.length > 0){
							for (var i = 0; i < reposToBeSetup.length; i++){
								redis.rpush(tasksListName, JSON.stringify({ownerId: nextTask.userId, repoName: reposToBeSetup[i].name, type: 'hook', newUser: nextTask.newUser}));
							}
						}
						//Schedule the next user new repo search in an hour
						addDelayedTask({type: 'userRepos', userId: nextTask.userId}, Date.now() + config.github.repoRefreshInterval, callback);
						//callback();
					});
				} else callback();
			});
		} else if (nextTask.type == 'hook'){
			var ownerId = nextTask.ownerId;
			User.findOne({id: ownerId}, function(err, repoOwner){
				if (err){
					redis.rpush(failedTasksListName, nextTaskRaw);
					console.error('Error while getting from the DB the user ' + ownerId + ' (owner of repo ' + nextTask.repoName + '): ' + err);
					callback();
					return;
				}
				if (!repoOwner){
					redis.rpush(failedTasksListName, nextTaskRaw);
					console.error('Cannot find owner of repo ' + nextTask.repoName + ' (userId: ' + ownerId + '): ' + err);
					callback();
					return;
				}
				var ownerName = repoOwner.username;
				var repoName = nextTask.repoName;
				var cClient = ghClientForToken(repoOwner.token);
				cClient.repo.get({headers: config.github.headers, user: ownerName, repo: repoName}, function(err, repoObj){
					if (err){
						console.error('Error while getting repo info: ' + err);
						return;
					}
					scheduleForRepo(repoOwner, repoObj, function(err){
						if (err){
							console.error('Error while setting up hook for ' + ownerName + '/' + repoName + ':' + err);
							redis.rpush(failedTasksListName, nextTaskRaw);
							callback();
							return;
						}
						//Once that the hook is setup, schedule task to search for lessons through previous commits, if the user is not a new one!
						if (!nextTask.newUser){
							redis.rpush(tasksListName, {ownerName: repoOwner.username, ownerToken: repoOwner.token, repoName: repoName, type: 'commitSearch'});
						}
						callback();
					});
				});
			});
		} else if (nextTask.type == 'commitSearch'){
			var ownerName = nextTask.ownerName;
			var repoName = nextTask.repoName;
			var cClient = ghClientForToken(nextTask.ownerToken);
			var reqOptions = {
				user: ownerName,
				repo: repoName,
				headers: config.github.headers,
				since: Date(Date.now() - 24*60*60*1000),
				per_page: 100
			};
			cClient.repos.get({user: ownerName, repo: repoName, headers: config.github.headers}, function(err, repoDescription){
				if (err){
					console.error('Error while getting repo information for repo ' + ownerName + '/' + repoName + ': ' + err);
					redis.rpush(failedTasksListName, nextTaskRaw);
					callback();
					return;
				}
				var repoId = repoDescription.id;
				cClient.repos.getCommits(reqOptions, function(err, commitsData){
					if (err){
						console.error('Error while getting the last commits for repo ' + ownerName + '/' + repoName + ': ' + err);
						redis.rpush(failedTasksListName, nextTaskRaw);
						callback();
						return;
					}
					//No commits received
					if (!(commitsData && commitsData.length > 0)){
						callback();
						return;
					}
					for (var i = 0; i < commitsData.length; i++){
						var commitHash = commitsData[i].sha;
						var commitMessage = commitsData[i].commit.message;
						var parsedLesson = parseLesson(commitMessage);
						if (!parsedLesson) continue;
						var lessonObj = {
							id: crypto.pseudoRandomBytes(6).toString('base64'),
							lang: parsedLesson.lang || repoDescription.language,
							tags: parsedLesson.tags || [parsedLesson.lang],
							repoId: repoId,
							commitId: commitHash,
							author: committer.id,
							postHtml: pageDownSanitizer.makeHtml(parsedLesson.lesson)
						};
						var newLesson = new Lesson(lessonObj);
						newLesson.save(function(err){
							if (err){
								console.error('Error while saving lesson from worker: ' + JSON.stringify(lessonObj) + ':\n' + err);
							}
						});
					}
				});
			});
		} else {
			console.error('Unknown task type: ' + nextTaskRaw);
			redis.rpush(failedTasksListName, nextTaskRaw);
			callback();
			return;
		}
	});
}

function pendingTasksSchedulingCycle(){
	redis.hgetall(delayedTasksListName, function(err, delayedTasks){
		if (err){
			console.error('Error while getting the list of delayed tasks: ' + err);
			return;
		}
		if (!delayedTasks) return;

		//Sorting time points by chronological order
		var targetTimes = Object.keys(delayedTasks);
		targetTimes.sort(function(a,b){
			var aNum = Number(a), bNum = Number(b);
			if (isNaN(aNum) || isNaN(bNum) || aNum == bNum) return 0;
			return aNum < bNum ? -1 : 1;
		});

		var currentTime = Date.now();
		for (var i = 0; i < targetTimes.length; i++){
			if (targetTimes[i] <= currentTime){
				//Reading the part of the task list that must be put in the task queue
				var taskListPart;
				try {
					taskListPart = JSON.parse(delayedTasks[targetTimes[i]]);
				} catch (e){}

				//Remove that part from the delayed task list
				redis.hdel(delayedTasksListName, targetTimes[i]);

				//Skip if the part cannot be read
				if (!taskListPart){
					redis.rpush(failedTasksListName, delayedTasks[targetTimes[i]]);
					continue;
				}

				//Putting the new tasks at the end of the queue
				if (Array.isArray(taskListPart)){
					for (var j = 0; j < taskListPart.length; j++){
						redis.rpush(tasksListName, taskListPart[j]);
					}
				} else redis.rpush(tasksListName, taskListPart);
			} else break;
		}
	});
}

function addDelayedTask(task, toBeDoneTimestamp, callback){
	redis.hexists(delayedTasksListName, toBeDoneTimestamp, function(err, keyExists){
		if (err){
			callback(new Error('Error while determining whether a task is already scheduled for the given timestamp: ' + err));
			return;
		}
		if (keyExists){
			redis.hget(delayedTasksListName, toBeDoneTimestamp, function(err, currentTaskPointRaw){
				if (err){
					callback(new Error('Error while getting the task(s) already scheduled for the given timestamp: ' + err));
					return;
				}
				var currentTaskPoint;
				try {
					currentTaskPoint = JSON.parse(currentTaskPointRaw);
				} catch (e){
					callback(new Error('Existing tasks cannot be parsed'));
					return;
				}
				if (Array.isArray(currentTaskPoint)){
					currentTaskPoint.push(task);
				} else {
					currentTaskPoint = [currentTaskPoint, task];
				}
				redis.hset(delayedTasksListName, toBeDoneTimestamp, JSON.stringify(currentTaskPoint));
				callback();
			});
		} else {
			redis.hset(delayedTasksListName, toBeDoneTimestamp, JSON.stringify([task]));
			callback();
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
		var foundRepos = [];
		var foundErr;
		if (existingUser){
			var uClient = new githubApi({version: '3.0.0'});
			uClient.authenticate({
				type: 'oauth',
				token: existingUser.token
			});
			uClient.user.get({headers: config.github.headers}, function(err, currentUserProfile){
				if (err) {
					callback(err);
					return;
				}
				var currentUsername = currentUserProfile.login;
				uClient.repos.getFromUser({headers: config.github.headers, user: currentUsername}, function(err, userRepos){
					if (err){
						foundErr = err;
						dataCb();
						return;
					}
					if (userRepos && userRepos.length > 0){
						userRepos.forEach(function(r){ foundRepos.push(r); });
					}
					dataCb();
				});
			});
			uClient.user.getOrgs({headers: config.github.headers, per_page: 100}, function(err, orgs){
				if (err){
					foundErr = err;
					dataCb();
					return;
				}
				if (orgs && orgs.length > 0){
					for (var i = 0; i < orgs.length; i++){
						var orgName = orgs[i].login;
						//Get orgs repos
						var orgReq = {
							org: orgName,
							headers: config.github.headers
						};
						uClient.repos.getFromOrg(orgReq, function(err, orgRepos){
							if (err){
								foundErr = err;
								dataCb();
								return;
							}
							if (orgRepos && orgRepos.length > 0){
								orgRepos.forEach(function(r){ foundRepos.push(r); });
							}
							orgCb();
						});
					}

					var orgCount = 0;
					function orgCb(){
						orgCount++;
						if (orgCount == orgs.length) dataCb();
					}
				} else dataCb();
			});

			var cbCount = 0;
			function dataCb(){
				cbCount++;
				if (cbCount == 2){
					callback(foundErr, foundRepos);
				}
			}
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

	processOne();

}

function ghClientForToken(t){
	var c = new githubApi({version: '3.0.0'});
	c.authenticate({type: 'oauth', token: t});
	return c;
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
