var assert = require("chai").assert;
var GoFastServer = require("../index.js").Server;

// helpers
var validWorkerConfig = {
    concurrency: 1,
    apiKey: "DEADBEEF0BADCODE"
};

var validCodeConfig = {
    path: "testWorker"
};

var validCallbacks = {};

// tests
describe("basic tests", function () {
    it ("throws error without any arguments", function() {
        assert.throws(function() {
            new GoFastServer();
        }, Error);
    });

    it ("throws error without apiKey");
    it ("throws error without service name");

    it ("constructor doesn't throw with right arguments", function() {
        assert.doesNotThrow (function () {
            var server = new GoFastServer(validWorkerConfig, validCodeConfig, validCallbacks);
        });
    });
    it ("init doesn't throw", function() {
        var server = new GoFastServer(validWorkerConfig, validCodeConfig, validCallbacks);
        assert.doesNotThrow (function () {
            server.init();
        });
    });
});