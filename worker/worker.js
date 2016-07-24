var rest = require("restler");
var bunyan = require("bunyan");
var async = require("async");
var ip = require("ip");
var os = require("os");
var log;

function GoFastWorker(callbacks, options) {
    callbacks = callbacks || {};
    this.jobCallback = callbacks.jobCallback;

    options = options || {};
    this.verbose = (options.verbose !== false);

    this.restHeaders = {
        'Accept': '*/*',
        'User-Agent': 'GoFast Worker',
        'Worker-Host': ip.address()
    };
}

GoFastWorker.prototype.init = function() {
    // get command line arguments
    var serverIpArg, serverPortArg;
    process.argv.forEach(function(val) {
        if (/^server:/.test(val)) {
            var pieces = val.split(":");
            serverIpArg = pieces[1];
            serverPortArg = pieces[2];
        }
    });
    serverPortArg = serverPortArg || 8080;

    // parse arguments
    this.jobServer = serverIpArg;
    this.jobServerPort = 8080;
    this.jobServerBaseUrl = "http://" + this.jobServer + ":" + this.jobServerPort;

    this.logServer = serverIpArg;
    this.logServerPort = 8080;
    this.logServerUrl = "http://" + this.logServer + ":" + this.logServerPort + "/log";

    // start the logging
    this._logInit();

    // start job loop
    var getJob = this._getJob.bind(this);
    async.forever(
        getJob,
        function(err) {
            if (err === true) {
                log.info("Worker done, exiting");
                return;
            }

            log.error(err);
            throw err;
        }
    );
};

function BunyanRemoteLog(options, error) {
    options = options || {};
    if (!options.serverUrl) {
        throw new Error("Server must be defined for remote logging");
    }

    this.logServerUrl = options.serverUrl;
    console.log("Server URL:", options.serverUrl);
}

BunyanRemoteLog.prototype.write = function(record) {
    var logServerUrl = this.logServerUrl;

    console.log("Log server url:", logServerUrl);
    rest.postJson(logServerUrl, {
            data: record,
            timeout: 30000,
            headers: this.restHeaders,
        })
        .on('error', function(err) {
            console.log(err);
        });
};

GoFastWorker.prototype._logInit = function() {
    console.log("Starting logging service...");
    // fire up bunyan
    var streams = [];

    // TODO: save logs to server
    streams.push({
        level: 'info',
        stream: new BunyanRemoteLog({
            serverUrl: this.logServerUrl,
            type: "raw"
        })
    });

    // print logs to screen
    if (this.verbose) {
        streams.push({
            level: 'debug',
            stream: process.stdout.isTTY ? require('bunyan-pretty')() : process.stdout
        });
    }

    log = this.log = bunyan.createLogger({
        name: 'gofast-worker',
        hostname: os.hostname() + " (" + ip.address() + ")",
        streams: streams
    });
    log.info("Logging initialized.");
};

GoFastWorker.prototype._getJob = function(next) {
    var jobCallback = this.jobCallback.bind(this);
    var saveResult = this._saveResult.bind(this);
    var jobServerBaseUrl = this.jobServerBaseUrl;
    log.debug("URL:", jobServerBaseUrl);

    // return new Promise(function(resolve, reject) {
    // fetch job from server
    rest.get(jobServerBaseUrl + "/job", {
            timeout: 30000,
            headers: this.restHeaders,
        })
        .on("complete", function(data) {
            log.debug("Got job:", data);
            if (data.job === null) {
                return next(true);
            }

            // job callback
            jobCallback(data.job, function(err, result) {
                if (err) {
                    log.error(err);
                }

                if (result) {
                    // save result
                    saveResult(result, next);
                }
            });
        })
        .on("timeout", function(ms) {
            log.error("request timed out");
        });
    // });
};

GoFastWorker.prototype._saveResult = function(result, done) {
    log.debug("Saving result");
    setTimeout(done, 2000);
};

module.exports = GoFastWorker;