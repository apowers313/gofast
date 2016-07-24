var gofast = require("../index.js");
var GoFastServer = gofast.Server;

var validWorkerConfig = {
    client: {
        provider: "digitalocean",
        token: "DEADBEEF0BADCODE"
    },
    server: {
        name: 'gofast-test',
        flavor: '512mb',
        image: 'ubuntu-14-04-x64',
        region: "SFO1",
        // keynames: ["RSA Key"],
        // keyname: ["RSA Key"]
        // ssh_keys: [
        // "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDM+7sZrv+qe3nKqYbIqKC8FeW98cWLodU6lzMlV7Qw3DKrzcewZkzQVh5184i7u2+Bj1TN0mkTec4GgP9HsZaOGsxyiLupYLwP6kTmJDyKZKp63cWygkChQoHmz8ZwaDcFD4veJcs/9PWwx10b/Lmr4MDQk7d/7FZmo3XPXsATA29KpjNnf/92d8WbO7biPDbpLIIOkwUeDxsqjct89q674FcXl6e1QKPyHBK6TibLeOV0EUw1i5kytE7iuQCITZ3lP/A8t1Bzcu1oYmpu9m3Joyxef42bRMfcYbtfUrZM+kimjdGAR9OiYnvblvusWBEnS9kKhjS1LDNgNlrH+4wH apowers@Werky.local",
        // "RSA Key"
        // ]
    },
    conn: {
        user: "root",
        pkFile: "/Users/apowers/.ssh/id_rsa"
    }
    
};

var validCodeConfig = {
    path: "./worker-example"
};

var validCallbacks = {
    getJob: getJob,
    receiveResult: receiveResult,
};

var validOptions = {
    concurrency: 2
};

var server = new GoFastServer(validWorkerConfig, validCodeConfig, validCallbacks, validOptions);
server.init();

var i = 0;
function getJob(done) {
    // console.log ("getJob");
    this.log.info ("getJob");
    i++;
    if (i > 10) done (null);
    else done ("job " + i);
}

function receiveResult(result) {
    // console.log ("receiveResult");
}