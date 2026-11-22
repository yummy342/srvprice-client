#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('ucloud cli 0.3.10 (fake)\n'); process.exit(0); }
if (args[0] === 'config' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('Something wrong. RetCode:299. Message:IAM permission error\n');
process.exit(0);
