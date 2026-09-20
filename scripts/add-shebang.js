#!/usr/bin/env node
// tsc always emits `"use strict";` as the literal first line of CommonJS
// output, which would push a shebang comment out of position (Unix only
// executes `#!` when it's the very first bytes of the file). This prepends
// it to dist/cli.js after every build and marks the file executable.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const target = path.join(__dirname, "..", "dist", "cli.js");
const shebang = "#!/usr/bin/env node\n";

const contents = fs.readFileSync(target, "utf-8");
if (!contents.startsWith(shebang)) {
  fs.writeFileSync(target, shebang + contents, "utf-8");
}
fs.chmodSync(target, 0o755);
