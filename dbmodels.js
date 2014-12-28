var config = require('./config.json');
var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var User = new Schema({
	id: String,
	username: String,
	code: String,
	token: String,
	avatarUrl: String
});

var Lesson = new Schema({
	id: String,
	author: String,
	postDate: {type: Date, default: Date.now},
	postHtml: String,
	views: {type: Number, default: 0},
	stars: {type: Number, default: 0},
	tags: String,
	lang: String,
	repoId: String,
	commitId: String,
	parentCommitId: String
});

/*var Star = new Schema({
	userId: String,
	lessonId: String
});*/

/*var Session = new Schema({
	userId: String,
	sessionCookie: String
});*/

var Hook = new Schema({
	linkedUserId: String,
	ownerId: String,
	ownerName: String,
	name: String,
	repoId: String,
	secret: String,
	url: String,
	addDate: {type: Date, default: Date.now}
});

var connStr = 'mongodb://';
if (config.db.user && config.db.pass){
	connStr += config.db.user + ':' + config.db.pass + '@';
}
connStr += config.db.host + ':' + (config.db.port || 27017) + '/' + config.db.dbname;

mongoose.model('User', User);
mongoose.model('Lesson', Lesson);
//mongoose.model('Star', Star);
//mongoose.model('Session', Session);
mongoose.model('Hook', Hook);

mongoose.connect(connStr, function(err){
	if (err) console.error('Error while hooking up with MongoDB: ' + err);
});

mongoose.connection.on('error', function(err){
	console.error('Error with the MongoDB connection: ' + err);
});

mongoose.connection.once('open', function(){
	console.log('Connection to DB established');
});
