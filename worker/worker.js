var rest = require("restler");
var bunyan = require("bunyan");
var log;

function GoFastWorker(callbacks, options) {
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
    async.forever(
        this._getJob,
        function(err) {
            if (err === true) {
                log.info ("Worker done, exiting");
                return;
            }

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
    var jobCallback = this.jobCallback;
    var jobServerBaseUrl = this.jobServerBaseUrl;

    return new Promise(function(resolve, reject) {
        // fetch job from server
        rest.get(jobServerBaseUrl + "/job", {
                timeout: 30000
            })
            .on("complete", function(data) {
                log.debug("Got job:", data);
                if (data.job === null) {
                    haveJob = false;
                }

                // job callback
                jobCallback(data.job);
            })
            .on("timeout", function(ms) {
                log.error("request timed out");
            });
    });
};

module.exports = GoFastWorker;