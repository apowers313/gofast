var gofast = require("gofast");
var GoFastWorker = gofast.Worker;

console.log ("worker running");
console.log ("arguments", process.argv);

var worker = new GoFastWorker({jobCallback: doJob});
worker.init();

function doJob(job, done) {
    console.log ("Doing job");
    this.log.info ("Doing job", job);
    done (null, "Okay!");
}

