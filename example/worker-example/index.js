var gofast = require("gofast");
var GoFastWorker = gofast.Worker;
var log;

console.log ("worker running");
console.log ("arguments", process.argv);

var worker = new GoFastWorker({jobCallback: doJob});
worker.init();

function doJob(job, done) {
    log = this.log; // running in the context of the GoFastWorker
    log.info ("Doing job", job);
    // ... do stuff here ...
    done (null, "Okay!");
}

