#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('ucloud cli 0.3.10 (fake)\n'); process.exit(0); }
// 真机行为：未配置凭据时退出码 0，只打印一句提示
process.stdout.write("private-key is empty. Execute command 'ucloud init|config' to configure it or run 'ucloud config list' to check your configurations\n");
process.exit(0);
