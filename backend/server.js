var http = require('http'),
	express = require('express'),
    app = module.exports.app = express(),
    server = http.createServer(app),
    io = require('socket.io').listen(server),
    fs = require('fs'),
    path = require('path');

var bodyParser = require('body-parser'),
	config = require('./inc/config'),
	api = require('node-twitter-api'),
	twitter_media = require('twitter-media'),
	twitter = new api(config),
	uuid = require('uuid'),
	cookieParser = require('cookie-parser'),
	bunyan = require('bunyan'),
	log = bunyan.createLogger({name: 'twitter-app'});

var spawn = require('child_process').spawn;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser.raw({ type: 'application/octet-stream',limit: '10mb'}));
app.use(cookieParser());
app.use(express.static('public'));

app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', config.origin);
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTION');
    res.header('Access-Control-Allow-Headers', 'Content-Type,X-File-Date,X-Requested-With,X-File-Type,X-File-Name,X-File-Size');
    res.header('Access-Control-Allow-Credentials', 'true');
    next();
});


/* LOG STREAMING */

io.on('connection', function (socket) {
  
  var tail = spawn("tail", ["-f", config.log]);
  tail.stdout.on("data", function (data) {
    socket.send({ tail : data.toString('utf-8') })
  }); 

});

/* TWITTER APP */
	
var router = express.Router();

app.use(function (req, res, go) {

	req._userCookie = req.cookies.uuid || false;
	req._userSession = req.cookies.session || false;
	req._accessToken = req.cookies.accessToken || false;
	req._accessSecret = req.cookies.accessTokenSecret || false;

	req._sessionInfo = {cookie:req._userCookie,session:req._userSession};
	
	if(!req._userSession){
		req._userSession = uuid.v4({node: [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]});
		res.cookie('session', req._userSession, { domain:config.domain });
	}

	if(!req._userCookie){

		var year = new Date();
		year.setTime(year.getTime() + (86400000 * 365))

		req._userCookie = uuid.v4({node: [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]});
		res.cookie('uuid', req._userCookie, { expires: year,domain:config.domain });

		req._accessToken = false;
		req._accessSecret = false;

		log.info('first visit',req._sessionInfo);
	}

	go();

});


router.get('/', function(req, res) {
	res.json({ message: 'API' });   
});

router.get('/check_if_logged', function(req, res) {

	twitter.verifyCredentials(req._accessToken, req._accessSecret, function(error, data, response) {
		if (error) {
			res.json({logged: false});
			log.info('check_if_logged',req._sessionInfo,{logged: false},error);
		} else {
			res.json({
				logged:data.screen_name,
				image:data.profile_image_url
			});
			log.info('check_if_logged',req._sessionInfo,{logged: data.screen_name});
		}
	});

});

router.post('/post', function(req, res,next) {

	var file = './uploads/'+req.body.attachment;
	req._media_id_string = false;

	try {
    	fs.accessSync(file, fs.F_OK);
	} catch (e) {
	    file = false;
	}

	if(!file){
		next();
	}else{

		/* using two different modules, a little bit clunky, to fix  */

		var ext = path.extname(file);

		if(ext == '.mov'){

			var video = fs.readFileSync(file);

			var tw = new twitter_media({
			    consumer_key: config.consumerKey,
			    consumer_secret: config.consumerSecret,
			    token: req._accessToken,
			    token_secret: req._accessSecret
			});

			tw.uploadMedia('video', video,function(error,data){
				if (error) {
					log.info('post-media',req._sessionInfo, { attachment: req.body.attachment,media:file },'error',error);
				} else {
					req._media_id_string = data;
				    log.info('post-media',req._sessionInfo, { attachment: req.body.attachment,media:file  },'ok');
				}
				next();
			});

		}else{

			twitter.uploadMedia({media:file}, req._accessToken, req._accessSecret,function(error,data){
				if (error) {
					log.info('post-media',req._sessionInfo, { attachment: req.body.attachment,media:file },'error',error);
				} else {
					req._media_id_string = data.media_id_string;
				    log.info('post-media',req._sessionInfo, { attachment: req.body.attachment,media:file  },'ok');
				}
				next();
			});

		}

	}


}, function(req, res, next) {

	var status = { status: req.body.tweet };

	if(req._media_id_string){
		status['media_ids'] = [req._media_id_string];
	}

	twitter.statuses("update",status,req._accessToken, req._accessSecret, function(error, data, response) {
		if (error) {
			log.info('post',req._sessionInfo, status,'error',error);
		    res.json({ message: 'error','info':error });  
		} else {
		    res.json({ message: 'ok',id:data.id_str,user:data.user.screen_name });  
		    log.info('post',req._sessionInfo, status,'ok');
		}
    });

});

router.post('/upload',function(req, res) {

	var folder = Date.now();
	var allowedformats = ['image/jpeg','image/png','image/gif','video/quicktime'];

	try {
		fs.mkdirSync('./uploads/'+folder);
	} catch(e) {
		//pass
	}

	if(allowedformats.indexOf(req.headers['x-file-type']) == -1){
		log.info('upload',req._sessionInfo, { wrong_filetype: req.headers['x-file-type'] },'error');
		res.json({upload: 'error-filetype'});
		return;
	}

	var target = [folder,req.headers['x-file-name']].join("/"); 

	fs.writeFile('./uploads/'+target, req.body, function(err) {
	    if(err) {
			res.json({upload: 'error'});	
			log.info('upload',req._sessionInfo, error,'error');
	    }else{
	    	log.info('upload',req._sessionInfo, target,'ok');
	    	res.json({upload: 'ok',place:target,name:req.headers['x-file-name']});	
	    }
	}); 

});



router.get('/log_out', function(req, res) {
	res.cookie('accessToken',false,{domain:config.domain});
	res.cookie('accessTokenSecret',false,{domain:config.domain});
	res.redirect(config.page);
});

router.get('/request_token', function(req, res) {

	twitter.getRequestToken(function(error, token, secret, results){
		if (error) {
			log.error('request_token',req._sessionInfo,error);
			res.redirect(config.page+'/?autherror');
		} else {
			log.info('request_token',req._sessionInfo,'oauth redirect');
			res.cookie('requestToken', token,{domain:config.domain});
			res.cookie('requestTokenSecret', secret,{domain:config.domain});
			res.redirect(config.oauth+token);  
		}
	});

});

router.get('/access_token', function(req, res) {

	twitter.getAccessToken(

		req.cookies.requestToken, 
		req.cookies.requestTokenSecret, 
		req.query.oauth_verifier

	,function(error, accessToken, accessTokenSecret, data) {

		if (error) {
			log.error('access_token',req._sessionInfo,error);
			res.redirect(config.page+'/?autherror');
		} else {
			res.cookie('accessToken', accessToken,{domain:config.domain});
			res.cookie('accessTokenSecret', accessTokenSecret,{domain:config.domain});
			log.info('access_token',req._sessionInfo,'oauth OK');
			res.redirect(config.page);
		}

	});

});

app.use('/api', router);
server.listen(process.env.PORT || 8080);