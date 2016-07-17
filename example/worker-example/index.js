var gofast = require("gofast");
var GoFastWorker = gofast.Worker;

var worker = new GoFastWorker({jobCallback: doJob});
worker.init();

function doJob(job) {
    console.log ("Doing job");
}

console.log ("worker running");
console.log ("arguments", process.argv);