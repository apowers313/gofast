var rest = require("restler");
var bunyan = require("bunyan");
var async = require("async");
var log;

function GoFastWorker(callbacks, options) {
    callbacks = callbacks || {};
    this.jobCallback = callbacks.jobCallback;

    options = options || {};
    this.verbose = (options.verbose !== false);
}

GoFastWorker.prototype.init = function() {
    // parse arguments
    this.jobServer = "localhost";
    this.jobServerPort = 8080;
    this.jobServerBaseUrl = "http://" + this.jobServer + ":" + this.jobServerPort;

    // start the logging
    this._logInit();

    // start job loop
    var getJob = this._getJob.bind(this);
    async.forever(
        getJob,
        function(err) {
            if (err === true) {
                log.info ("Worker done, exiting");
                return;
            }

            log.error (err);
            throw err;
        }
    );
};

GoFastWorker.prototype._logInit = function() {
    console.log("Starting logging service...");
    // fire up bunyan
    var streams = [];

    // TODO: save logs to server
    // streams.push({
    //     level: 'info',
    //     path: this.logfile
    // });

    // print logs to screen
    if (this.verbose) {
        streams.push({
            level: 'debug',
            stream: process.stdout.isTTY ? require('bunyan-pretty')() : process.stdout
        });
    }

    log = this.log = bunyan.createLogger({
        name: 'gofast-worker',
        streams: streams
    });
    log.info("Logging initialized");
};

GoFastWorker.prototype._getJob = function(next) {
    var jobCallback = this.jobCallback.bind(this);
    var saveResult = this._saveResult.bind(this);
    var jobServerBaseUrl = this.jobServerBaseUrl;
    log.debug ("URL:", jobServerBaseUrl);

    // return new Promise(function(resolve, reject) {
        // fetch job from server
        rest.get(jobServerBaseUrl + "/job", {
                timeout: 30000
            })
            .on("complete", function(data) {
                log.debug("Got job:", data);
                if (data.job === null) {
                    return next (true);
                }

                // job callback
                jobCallback(data.job, function(err, result) {
                    if (err) {
                        log.error (err);
                    }

                    if (result) {
                        // save result
                        saveResult (result, next);
                    }
                });
            })
            .on("timeout", function(ms) {
                log.error("request timed out");
            });
    // });
};

GoFastWorker.prototype._saveResult = function(result, done) {
    log.debug ("Saving result");
    setTimeout (done, 2000);
};

module.exports = GoFastWorker;