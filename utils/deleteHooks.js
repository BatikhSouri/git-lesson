var readline = require('readline');
var config = require('../config');
var mongoose = require('mongoose');
var dbmodels = require('../dbmodels');
var Hook = mongoose.model('Hook');
var User = mongoose.model('User');

var githubApi = require('github');

var params = [];
//If repoIDs are passed as inline parameters
if (process.argv.length > 2){
	for (var i = 2; i < process.argv.length; i++){
		var currentParameter = process.argv[i];
		currentParameter = Number(currentParameter);
		if (isNaN(currentParameter)){
			console.log(process.argv[i] + ' is not a valid repoId');
			process.exit(1);
		}
		params.push(currentParameter);
	}
}

if (params.length > 0){
	getHooksById(params, function(err, hooks){
		if (err) throw err;

		deleteHooks(hooks);
	})
} else {
	var rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	rl.question('Are you sure you want to delete all hooks? (y/n)', function(ans){
		if (ans.toLowerCase().indexOf('y') == 0){
			rl.close();
			console.log('\nDeleting all hooks!');

			Hook.find({}, function(err, hooks){
				if (err) throw err;

				deleteHooks(hooks);
			});
		} else {
			console.error('\nAborting!');
			process.exit();
		}
	});
}

function getHooksById(idArray, callback){
	var foundRepos = [];
	var IDindex = 0;
	var stackCounter = 0;

	function getOne(){
		Hook.findOne({id: idArray[IDindex]}, function(err, foundRepo){
			if (err){
				callback(err);
				return;
			}
			if (foundRepo) foundRepos.push(foundRepo);

			IDindex++;
			if (IDindex == idArray.length){
				callback(null, foundRepos);
				return;
			}

			stackCounter++;
			if (stackCounter >= 1000){
				stackCounter = 0;
				setTimeout(getOne, 0);
			} else getOne();

		})
	}

	getOne();
}

function deleteHooks(hooks){
	if (hooks.length == 0){
		console.log('No hooks to be deleted');
		process.exit();
	}

	var stackCount = 0;

	var iRepos = 0;
	var currentRepoOwner;
	var ghClient;

	function processOne(){
		var currentRepo = hooks[iRepos];

		if (!(currentRepoOwner && (currentRepoOwner.id == currentRepo.linkedUserId || currentRepoOwner.id == currentRepo.ownerId))){

			var ownerQuery;
			if (currentRepo.linkedUserId) ownerQuery = {id: currentRepo.linkedUserId};
			else ownerQuery = {id: currentRepo.ownerId};

			User.findOne(ownerQuery, function(err, repoOwner){
				if (err) throw err;
				if (!repoOwner){
					console.error('Cannot find owner for repo ' + currentRepo.id);
					process.exit(1);
				}
				currentRepoOwner = repoOwner;
				ghClient = ghClientForToken(currentRepoOwner.token);
				deleteCurrentHook();
			});

		} else deleteCurrentHook();

		function deleteCurrentHook(){
			var repoOwnerName = currentRepo.ownerName || currentRepoOwner.username;
			ghClient.repos.getHooks({user: repoOwnerName, repo: currentRepo.name, per_page: 100}, function(err, setHooks){
				if (err) throw err;
				if (!(setHooks && setHooks.length > 0)){
					end();
					return;
				}
				for (var i = 0; i < setHooks.length; i++){
					if (setHooks[i].config.url == config.github.hookUrl){
						ghClient.repos.deleteHook({id: setHooks[i].id, user: repoOwnerName, repo: currentRepo.name}, function(err){
							if (err) throw err;
							Hook.remove({repoId: currentRepo.repoId}, function(err){
								if (err) throw err;
								console.log('git-lesson hook ' + repoOwnerName + '/' + currentRepo.name + ' has been deleted');
								end();
							});
						});
						break;
					}
				}
			});
		}


		function end(){
			iRepos++;
			if (iRepos == hooks.length){
				console.log('End of script');
				process.exit();
			} else {
				stackCount++;
				if (stackCount >= 1000){
					stackCount = 0;
					setTimeout(processOne, 0);
				} else processOne();
			}
		}
	}
	processOne();
}

function ghClientForToken(t){
	var c = new githubApi({version: '3.0.0'});
	c.authenticate({type: 'oauth', token: t});
	return c;
}
