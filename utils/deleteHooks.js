var config = require('../config');
var mongoose = require('mongoose');
var dbmodels = require('../dbmodels');
var Hook = mongoose.model('Hook');
var User = mongoose.model('User');

var githubApi = require('github');

Hook.find({}, function(err, hooks){
	if (err) throw err;

	console.log('Saved hooks: ' + JSON.stringify(hooks));

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
});

function ghClientForToken(t){
	var c = new githubApi({version: '3.0.0'});
	c.authenticate({type: 'oauth', token: t});
	return c;
}
