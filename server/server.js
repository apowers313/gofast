var fs = require("fs");
var util = require("util");
var bunyan = require("bunyan");
var restify = require("restify");
var ip = require("ip");
var log, server;

// config
var serverPort = 8080;
var npmStartCmd = "npm start -- server:%s:%s";
var serverStartupDelay = 65000;

function GoFastServer(workerConfig, projectConfig, callbacks, options) {
    var self = this;

    if (typeof workerConfig !== "object" || typeof projectConfig !== "object" || typeof callbacks !== "object") {
        throw new Error("new GoFastServer requires workerConfig, projectConfig, and callbacks objects as parameters");
    }

    /* 
    workerConfig:
        api:
            provider: string, "digitalocean"; see pkgcloud docs
            token: string, key for service API management
        server:
            image: string, what image to use for the server (e.g. - Ubuntu, CoreOS)
        config:
            user: string, the user to use for ssh (default: root)
            pkFile: string, path to the private key file (default: ~/.ssh/id_rsa)
    */
    if (typeof workerConfig !== "object" ||
        typeof workerConfig.api !== "object" ||
        typeof workerConfig.api.provider !== "string" ||
        typeof workerConfig.server.region !== "string" ||
        typeof workerConfig.server.size !== "string" ||
        typeof workerConfig.server.ssh_keys !== "object" ||
        typeof workerConfig.server.image !== "string" ||
        typeof workerConfig.config.user !== "string" ||
        typeof workerConfig.config.pkFile !== "string" ||
        typeof workerConfig.config.setupCmds !== "object") {
        throw new Error("bad workerConfig object, should be a proper pkgcloud config object");
    }

    // prefer the API token from the environment, if it exists
    this.workerConfig = workerConfig;
    this.token = process.env.GOFAST_TOKEN || workerConfig.token;
    if (typeof this.token !== "string") {
        throw new Error("need API key for starting workers");
    }
    this.workerConfig.api.token = this.token;

    // convert any function strings to functions
    this.workerConfig.config.setupCmds = this.workerConfig.config.setupCmds.map(function(cmd) {
        if (typeof cmd.function === "string") {
            switch (cmd.function) {
                case "sshExec":
                    cmd.function = self._sshExec;
                    return cmd;
                default:
                    throw new Error("Unknown string for function:", cmd.function);
            }
        }
    });

    /*
    projectConfig:
        path: folder of the worker npm project
    */
    if (typeof projectConfig.path !== "string") {
        throw new Error("expected projectConfig.path to be a string that points to the directory of the worker npm project");
    }
    this.workerProjectPath = projectConfig.path;

    /*
    callbacks:
        buildWorkerImage
        workerSetup
        workerStart
        getJob
        receiveResult
        workerShutdown
    */
    // install callbacks
    if (callbacks.buildWorkerImage) this.buildWorkerImage = callbacks.buildWorkerImage;
    if (callbacks.workerSetup) this.workerSetup = callbacks.workerSetup;
    if (callbacks.workerStart) this.workerStart = callbacks.workerStart;
    if (callbacks.getJob) this.getJob = callbacks.getJob;
    if (callbacks.receiveResult) this.receiveResult = callbacks.receiveResult;
    if (callbacks.workerShutdown) this.workerShutdown = callbacks.workerShutdown;

    /*
    options:
        logfile: string, path to logfile (default: "./gofast.log")
        verbose: boolean, whether to output debug messages to screen (default: false)
        proxy: boolean, whether or not to use a HTTP proxy so that workers can send back requests (default: true)
        concurrency: integer, number of simultaneous workers (default: 10)
    */
    options = options || {};
    this.logfile = options.logfile || "./gofast.log";
    this.verbose = options.verbose || true; // TODO: make this false before publishing
    this.proxy = (options.proxy !== false);
    this.serverIpAddress = ip.address();
    if (typeof options.concurrency !== "number" && typeof options.concurrency !== "undefined") {
        throw new Error("expected options.concurrency to be the number of workers to start");
    }
    this.workerConcurrency = options.concurrency || 10;
    this.test = options.test;
    this.testVerbose = options.testVerbose;
    // this.test = true;

    this.workerList = [];
}

GoFastServer.prototype._doRawLog = function(str) {
    var strs = str.split("\n");
    var i;

    for (i = 0; i < strs.length; i++) {
        str = strs[i];
        if (/^{.+}$/m.test(str)) {
            // console.log ("Got data: \"%s\"", str);
            try {
                log._emit(JSON.parse(str));
            } catch (err) {
                log.error(err);
            }
        }
    }
};

GoFastServer.prototype.init = function() {
    var self = this;
    // start logging service
    this._logInit();

    // start webserver
    this._commInit();

    // if debugging, wait a few seconds and start the worker locally, and don't do the rest of the stuff below
    if (this.test) {
        var path = this.workerProjectPath;
        var rawLog = this._doRawLog.bind(this);
        var testVerbose = this.testVerbose;
        var serverIpAddress = this.serverIpAddress;

        log.warn("!!! RUNNING IN DEBUG MODE -- EXECUTING LOCAL WORKER");
        setTimeout(function() {
            // package up the worker project using npm
            var exec = require("child_process").exec;
            var cmd = util.format(npmStartCmd, serverIpAddress, serverPort);
            log.info("Starting with cmd:", cmd);
            var child = exec(cmd, {
                cwd: path,
                stdio: ["ignore", "inherit", "inherit"]
            });
            if (testVerbose) {
                child.stdout.on('data', function(data) {
                    console.log("stdout: \"%s\"", data);
                    rawLog(data);
                });
                child.stderr.on('data', function(data) {
                    console.log("stderr: \"%s\"", data);
                    rawLog(data);
                });
            }
        }, 2000);
        return;
    }

    // start proxy server
    var proxyPromise;
    if (this.proxy) {
        proxyPromise = this._sshReverseTunnel()
            .then(function(server) {
                log.info("Reverse tunnel done");
                self.proxyServer = server;
                this.serverIpAddress = server.networks.v4[0].ip_address;
                return server;
            })
            .catch(function(err) {
                log.error(err);
            });
    } else {
        proxyPromise = Promise.resolve();
    }

    // build image
    this.buildWorkerImage();

    // start workers
    proxyPromise
        .then(function() {
            log.info("Starting workers");
            self._startWorkers();
        })
        .catch(function(err) {
            log.error(err);
        });
};

GoFastServer.prototype._logInit = function() {
    console.log("Starting logging service...");
    // fire up bunyan
    var streams = [];

    // save logs to logfile
    streams.push({
        level: 'info',
        path: this.logfile
    });

    // print logs to screen
    if (this.verbose) {
        streams.push({
            level: 'debug',
            stream: process.stdout.isTTY ? require('bunyan-pretty')() : process.stdout
        });
    }

    log = this.log = bunyan.createLogger({
        name: 'gofast-server',
        streams: streams
    });
    log.info("Logging initialized");
};

GoFastServer.prototype._commInit = function() {
    // create REST server
    log.info("Initializing REST server...");
    server = this.server = restify.createServer({
        name: 'gofast',
        version: '0.0.1',
        log: this.log
    });
    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.queryParser());
    server.use(restify.bodyParser({
        // mapParams: true,
        mapFiles: true,
        keepExtensions: true,
        uploadDir: "."
    }));
    server.use(restify.requestLogger());

    // create REST endpoints
    // /log for workers posting log messages
    server.post("/log", this._restLog.bind(this));

    // /job for workers getting jobs
    server.get("/job", this._restJob.bind(this));

    // /result for workers posting job results
    server.post("/result", this._restResult.bind(this));

    // start server
    server.listen(serverPort, function() { // TODO: use port: 0xFA57 ?
        log.info("%s listening at %s", server.name, server.url);
    });
};

GoFastServer.prototype._restLog = function(req, res, next) {
    // log.debug ("Log Body: \"" + req.body + "\"");
    this._doRawLog(req.body);
    res.json({
        result: "ok"
    });
};

function _getReqIpAddress(req) {
    if (ip.isEqual("127.0.0.1", req.connection.remoteAddress)) {
        // return req.headers.host.split(":")[0];
        log.debug("Returning X-Worker-Host IP address:", req.headers["x-worker-host"]);
        return req.headers["x-worker-host"];
    } else {
        return req.connection.remoteAddress;
    }
}

GoFastServer.prototype._restJob = function(req, res, next) {
    var self = this;

    // TODO: getJob should handle returned values and promises too...

    // get a job from the registered getJob() callback
    this.getJob(function(job) {
        res.json({
            job: job
        });

        log.debug("Job:", job);

        // if we get a null job, we don't have more work and it's time to shut down the worker
        if (job === null && !self.test) {
            log.debug("Shutting down worker:", _getReqIpAddress(req));
            self.workerShutdown(_getReqIpAddress(req))
                .then(function() {
                    log.info("Worker successfully shut down");
                    return next();
                })
                .catch(function(err) {
                    log.error(err);
                    return next(err);
                });
        }
    });
};

GoFastServer.prototype._restResult = function(req, res, next) {
    var self = this;
    var result = req.body;

    // try {
    this.receiveResult(result, function(err, resp) {
        log.debug("receiveResult done");
        if (err) log.warn(err);
        res.json(resp || {
            result: "ok"
        });
        next();
    });
    // } catch (err) {
    //     log.error(err);
    //     next(err);
    // }
};

GoFastServer.prototype.buildWorkerImage = function() {
    var path = this.workerProjectPath;

    // package up the worker project using npm
    var exec = require("child_process").execSync;
    exec("npm pack " + path, {
        stdio: "inherit"
    });

    var p = require("path");
    var pkgJsonPath = p.join(path, "package.json");
    var pkg = JSON.parse(fs.readFileSync(pkgJsonPath));
    var pkgFile = pkg.name + "-" + pkg.version + ".tgz";
    log.info("Created NPM Package: %s, Version: %s (%s)", pkg.name, pkg.version, pkgFile);
    this.workerPackage = pkgFile;
    this.workerModuleName = pkg.name;

    // var npm = require("npm");
    // npm.load(function(err) {
    //     // if (err) return handlError(err);
    //     console.log ("err1:", err);
    //     npm.commands.pack([path], function(err, data) {
    //         console.log ("err2:", err);
    //         console.log ("data:", data);
    //         // if (err) return commandFailed(err);
    //             // command succeeded, and data might have some info
    //     });
    // });
};

GoFastServer.prototype._startServer = function(options) {
    options = options || {};
    var name = options.name || "gofast-server";
    var number = options.number;
    if (typeof number === "number") name = name + ('000' + number).slice(-3);
    var digitalocean = require("digitalocean");
    var client = digitalocean.client(this.workerConfig.api.token);
    var opts = JSON.parse(JSON.stringify(this.workerConfig.server)); // cheap object copy
    opts.name = name;

    return new Promise(function(resolve, reject) {
        client.droplets.create(opts, function(err, newServer) {
            if (err) {
                log.error(err);
                throw new Error(err);
            }
            // log.info("SERVER INFO:", newServer);
            log.debug("Waiting 60 seconds for %s to start...", name);
            setTimeout(function() { // TODO: poll server status
                client.droplets.get(newServer.id, function(err, server) {
                    if (err) {
                        log.error(err);
                        throw new Error(err);
                    }

                    // log.info("SERVER STATUS:", server);
                    if (server.status === "active") log.info("ACTIVE!");
                    else log.info("NOT ACTIVE :(");
                    log.info(server.networks.v4[0].ip_address);
                    resolve(server);
                });
            }, serverStartupDelay);
        });
    });

    /*
    // pkgcloud is broken -- ssh keys currently don't work on DigitalOcean
    // see also: https://github.com/pkgcloud/pkgcloud/issues/523
    var pkgcloud = require("pkgcloud");

    // pkgcloud init
    log.info("pkg cloud client:", this.workerConfig.client);

    // setup API client
    var client = pkgcloud.compute.createClient(this.workerConfig.client);

    client.listKeys (function (err, keys) {
        if (err) log.error (err);
        log.info (keys);
    });

    // create server
    this.workerConfig.server.name = "gofast-test"; // TODO
    client.createServer(this.workerConfig.server, function(err, server) {
        if (err) {
            log.error(err);
        } else {
            log.debug("SERVER INFO:", server);
            // Wait for the server to reach the RUNNING state.
            log.debug('waiting for server RUNNING state...');
            setTimeout (function() {
                client.getServer(server.id, function (err, serverInfo) {
                    if (err) log.error (err);
                    log.debug("SERVER INFO 2:", serverInfo);
                });
            }, 30000);
            // server.setWait({
            //     status: server.STATUS.running
            // }, 10000, function(err, server) {
            //     if (err) {
            //         log.error(err);
            //     } else {
            //         log.info(server);
            //     }
            // });
        }
    });
    */
};

GoFastServer.prototype._startWorkers = function() {
    var self = this;
    var i;

    log.info("Starting %d workers...", this.workerConcurrency);
    for (i = 1; i <= this.workerConcurrency; i++) {
        self._startServer({
                name: "gofast-worker",
                number: i
            })
            .then(function(server) {
                self.workerSetup(server, function(err) {
                    if (err) {
                        log.error(err);
                        throw new Error(err);
                    }
                    self.workerStart(server, function(err) {
                        if (err) {
                            log.error(err);
                            throw new Error(err);
                        }
                    });
                });
            });
    }
};

GoFastServer.prototype._promiseSequence = function(t, server, cmds) {
    var self = this;
    var p = Promise.resolve();

    cmds.forEach(function(cmd) {
        p = p.then(function() {
            var args = cmd.args.slice(0);
            args.unshift(server);
            return cmd.function.apply(self, args);
        });
    });

    return p;
};

GoFastServer.prototype.workerSetup = function(server, cb) {
    var self = this;
    var localPackage = this.workerPackage;
    var remotePackage = this.workerPackage; // TODO: be nicer about where the files get stored
    log.debug("Doing upload");
    this._sshUpload(server, localPackage, remotePackage)
        // .then(function() {
        //     log.debug("Upload done");
        //     cb(null);
        // })
        // TODO: set this up as an array that's passed in as an option and loop through the commands in the array
        .then(function() {
            return self._promiseSequence(this, server, self.workerConfig.config.setupCmds);
        })
        .then(function() {
            return self._sshExec(server, "npm install " + remotePackage);
        })
        .then(function() {
            // _sshExec node package args
            log.info("Setup done");
            cb(null, server);
        })
        .catch(function(err) {
            log.error(err);
            cb(err);
        });
};

var sshClient = require("ssh2").Client;

// var ipAddress = "159.203.246.158";
GoFastServer.prototype._sshConnect = function(server, cb, cnt) {
    var ipAddress = server.networks.v4[0].ip_address;
    var user = this.workerConfig.config.user;
    var pkFile = this.workerConfig.config.pkFile;

    log.debug("Doing SSH Connect...");
    try {
        var sshConn = new sshClient();
        sshConn.on("ready", function() {
            log.debug("SSH Connection ready");
            cb(null, sshConn);
        }).connect({
            host: ipAddress,
            port: 22,
            username: user,
            privateKey: require('fs').readFileSync(pkFile)
        });
    } catch (err) {
        log.warn(err);
        log.warn("Retrying sshConnect...");
        cnt = cnt || 6; // TODO: variable
        cnt--;
        setTimeout(function() {
            _sshConnect(server, cb, cnt);
        }, 5000); // TODO: variable

    }
};

GoFastServer.prototype._sshUpload = function(server, localFile, remoteFile) {
    var self = this;
    var ipAddress = server.networks.v4[0].ip_address;
    var user = this.workerConfig.config.user;

    return new Promise(function(resolve, reject) {
        log.info(`Copying ${localFile} to ${user}@${ipAddress}:${remoteFile}`);
        self._sshConnect(server, function(err, sshConn) {
            sshConn.sftp(function(err, sftpConn) {
                if (err) throw err;
                log.debug("SFTP Connection ready");
                sftpConn.fastPut(localFile, remoteFile, function(err) {
                    if (err) throw err;
                    log.info("Done uploading worker package!");
                    resolve(localFile);
                });
            });
        });
    });
};

GoFastServer.prototype._sshExec = function(server, cmd) {
    var self = this;

    return new Promise(function(resolve, reject) {
        self._sshConnect(server, function(err, sshConn) {
            sshConn.exec(cmd, function(err, stream) {
                if (err) {
                    log.error("Error Name:", err.name);
                    log.error("Error Message:", err.message);
                    log.error("Error Type:", err.type);
                    throw err;
                }
                log.debug("RUNNING CMD: \"%s\".", cmd);
                stream.on('close', function(code, signal) {
                    log.trace('Stream :: close :: code: ' + code + ', signal: ' + signal);
                    // sshConn.end();
                    log.debug("SSH CMD DONE: \"%s\"", cmd);
                    resolve(cmd);
                }).on('data', function(data) {
                    log.trace('STDOUT: ' + data);
                }).stderr.on('data', function(data) {
                    log.warn('STDERR: ' + data);
                });
            });
        });
    });
};

GoFastServer.prototype._sshReverseTunnel = function() {
    var tunnel = require("reverse-tunnel-ssh");
    var pkFile = this.workerConfig.config.pkFile;
    var self = this;
    var server;

    // start proxy server
    return self._startServer({
            name: "gofast-proxy"
        })
        .then(function(s) {
            server = s;
            // add "GatewayPorts yes" to "/etc/ssh/sshd_config" on remote server
            // see also: http://askubuntu.com/questions/50064/reverse-port-tunnelling
            return self._sshExec(server, 'echo "\nGatewayPorts yes\n" >> /etc/ssh/sshd_config');
        })
        .then(function() {
            return self._sshExec(server, "sudo reload ssh");
        })
        .then(function() {
            return new Promise(function(resolve, reject) {
                //tunnel is a ssh2 clientConnection object 
                tunnel({
                        host: server.networks.v4[0].ip_address,
                        username: 'root',
                        dstHost: '0.0.0.0', // bind to all interfaces 
                        dstPort: serverPort,
                        privateKey: require('fs').readFileSync(pkFile),
                        //srcHost: '127.0.0.1', // default 
                        //srcPort: dstPort // default is the same as dstPort 
                    }, function(err, clientConnection) {
                        if (err) throw err;
                        // log.info("tunnel got connection");
                    })
                    .on("ready", function() {
                        log.info("Tunnel ready");
                        resolve(server);
                    })
                    .on("continue", function() {
                        log.info("Tunnel ready to continue");
                    })
                    .on("error", function(err) {
                        log.error("Error connecting to tunnel");
                        reject(err);
                    })
                    .on("close", function(err) {
                        log.error("Tunnel closed");
                        reject(err);
                    })
                    .on("end", function(err) {
                        log.error("Tunnel ended");
                        reject(err);
                    });
            });

        })
        .catch(function(err) {
            log.error(err);
            cb(err);
        });
};

GoFastServer.prototype.workerStart = function(server, cb) {
    var self = this;
    var ipAddress = server.networks.v4[0].ip_address;
    var package = this.workerPackage;

    log.info("Starting worker %s...", ipAddress);

    // sshexec npm install && npm start
    var cmdPath = "node_modules/" + this.workerModuleName;
    var cmd = "cd " + cmdPath + " && " + util.format(npmStartCmd, serverIpAddress, serverPort);
    log.info("Running start command on server:", cmd);

    log.debug("Adding worker to list");
    self.workerList.push(server);
    log.debug("Worker list is %d long", self.workerList.length);

    return self._sshExec(server, cmd)
        .then(function() {
            return cb(null, server);
        })
        .catch(function(err) {
            log.error(err);
            return cb(err);
        });
};

/**
 * getJob
 * returns a job for a worker
 * if falsey is returned intead, the worker will be destroyed
 */
GoFastServer.prototype.getJob = function(done) {
    // empty function, in case the callback isn't implemented
    log.warn("Default getJob: consider implementing");
    done(null); // TODO: use promises instead?
};

GoFastServer.prototype.receiveResult = function(result, done) {
    // empty function, in case the callback isn't implemented
    log.warn("Default receiveResult: consider implementing");
    done(null);
};

function _findWorkerByIp(workerList, workerIp) {
    var index;
    var ret = workerList.filter(function(server, idx, arr) {
        if (ip.isEqual(workerIp, server.networks.v4[0].ip_address) && index === undefined) {
            index = idx;
            return true;
        }
    });

    if (ret.length < 1) {
        log.warn("Trying to find worker by IP: no workers found");
    }

    if (ret.length > 1) {
        log.warn("Trying to find worker by IP: multiple workers found");
    }

    // log.debug("Found worker ID:", ret[0]);
    return {
        worker: ret[0],
        idx: index
    };
}

GoFastServer.prototype.workerShutdown = function(workerIp) {
    var self = this;

    if (typeof workerIp !== "string") {
        log.error("workerIp not a string in workerShutdown:", workerIp);
    }

    return new Promise(function(resolve, reject) {

        log.info("Shutting down worker:", workerIp); // TODO: worker
        // empty function, in case the callback isn't implemented
        var ret = _findWorkerByIp(self.workerList, workerIp);
        var worker = ret.worker;
        var idx = ret.idx;
        var digitalocean = require("digitalocean");
        var client = digitalocean.client(self.workerConfig.api.token);
        log.info("Destroying worker:", worker.id);
        client.droplets.delete(worker.id, function(err) {
            if (err) {
                log.error(err);
                return reject(err);
            }

            // remove from workerList
            self.workerList.splice(idx, 1);
            log.debug(self.workerList.length, "workers remaining");
            if (self.workerList.length === 0) {
                // destroy proxy server and exit
                log.info("All done, destroying proxy");
                client.droplets.delete(self.proxyServer.id, function(err) {
                    if (err) {
                        log.error(err);
                        return reject(err);
                    }
                    return resolve(worker);
                    // TODO: complete shutdown of REST server, etc.
                });
            } else {
                return resolve(worker);
            }
        });
    });

};


module.exports = GoFastServer;