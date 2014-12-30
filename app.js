var express = require('express');
var http = require('http');
var path = require('path');
var favicon = require('static-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var cookieSession = require('cookie-session');
var bodyParser = require('body-parser');

var config = require('./config.json');
var worker = require('./worker');
var routes = require('./routes');
routes.setAddDelayedTask(worker.addDelayedTask);

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(favicon());
app.use(logger('dev'));
app.use(function(req, res, next){
    if (req.url.indexOf('/hook') != 0){
        next();
        return;
    }
    //Add the raw request body as req.rawBody if request is on /hook
    var rawReqBody = '';
    req.setEncoding('utf8');
    req.on('data', function(chunk){
        rawReqBody += chunk;
    });
    req.on('end', function(){
        req.rawBody = rawReqBody;
        next();
    })
})

app.use(bodyParser.json());
app.use(bodyParser.urlencoded());
app.use(cookieParser());
app.use(cookieSession(config.cookies));
app.use(require('stylus').middleware(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(app.router);

app.get('/', routes.index);
app.get('/latest', routes.latestLessons);
app.get('/lesson/:id', routes.showLesson);
app.get('/login', routes.login);
app.get('/logout', routes.logout);
app.post('/hook', routes.hook);

/// catch 404 and forwarding to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

/// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
    res.render('error', {
        message: err.message,
        error: {}
    });
});


if (module.parent){
    module.exports = app;
} else {
    var server = http.createServer(app);
    var serverPort = process.env.PORT || config.httpPort || 3000;
    server.listen(serverPort, function(){
        console.log('Express server listening on port ' + serverPort);
        worker.start(function(){
            console.log('Worker has been started');
        });
    });
}
