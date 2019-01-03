import * as fs from 'fs-extra';
import { readFile, writeFile, replaceInFile, prependToFile } from './fs';
import { execAndWaitForOutputToMatch, npm, silentNpm, ng } from './process';
import { getGlobalVariable } from './env';

const packages = require('../../../../lib/packages').packages;


const tsConfigPath = 'tsconfig.json';


export function updateJsonFile(filePath: string, fn: (json: any) => any | void) {
  return readFile(filePath)
    .then(tsConfigJson => {
      const tsConfig = JSON.parse(tsConfigJson);
      const result = fn(tsConfig) || tsConfig;

      return writeFile(filePath, JSON.stringify(result, null, 2));
    });
}


export function updateTsConfig(fn: (json: any) => any | void) {
  return updateJsonFile(tsConfigPath, fn);
}


export function ngServe(...args: string[]) {
  return execAndWaitForOutputToMatch('ng',
    ['serve', ...args],
    /: Compiled successfully./);
}


export function createProject(name: string, ...args: string[]) {
  const argv: any = getGlobalVariable('argv');

  return Promise.resolve()
    .then(() => process.chdir(getGlobalVariable('tmp-root')))
    .then(() => ng('new', name, '--skip-install', ...args))
    .then(() => process.chdir(name))
    .then(() => useBuiltPackages())
    .then(() => useCIChrome('e2e'))
    .then(() => useCIChrome('src'))
    .then(() => useDevKitSnapshots())
    .then(() => argv['ng2'] ? useNg2() : Promise.resolve())
    .then(() => argv['ng4'] ? useNg4() : Promise.resolve())
    .then(() => argv['ng-snapshots'] || argv['ng-tag'] ? useSha() : Promise.resolve())
    .then(() => console.log(`Project ${name} created... Installing npm.`))
    .then(() => silentNpm('install'))
    .then(() => useCIDefaults(name));
}


export function useDevKit(devkitRoot: string) {
  return Promise.resolve()
    .then(() => {
      // Load the packages info for devkit.
      const devkitPackages = require(devkitRoot + '/lib/packages').packages;

      return updateJsonFile('package.json', json => {
          if (!json['dependencies']) {
            json['dependencies'] = {};
          }
          if (!json['devDependencies']) {
            json['devDependencies'] = {};
          }

          for (const packageName of Object.keys(devkitPackages)) {
            if (json['dependencies'].hasOwnProperty(packageName)) {
              json['dependencies'][packageName] = devkitPackages[packageName].tar;
            } else if (json['devDependencies'].hasOwnProperty(packageName)) {
              json['devDependencies'][packageName] = devkitPackages[packageName].tar;
            }
          }
        });
    });
}

export function useDevKitSnapshots() {
  return updateJsonFile('package.json', json => {
    // TODO: actually add these.
    // These were not working on any test that ran `npm i`.
    // json['devDependencies']['@angular-devkit/build-angular'] =
    //   'github:angular/angular-devkit-build-angular-builds';
    // // By adding build-ng-packagr preemptively, adding a lib will not update it.
    // json['devDependencies']['@angular-devkit/build-ng-packagr'] =
    //   'github:angular/angular-devkit-build-ng-packagr-builds';
  });
}

export function useBuiltPackages() {
  return Promise.resolve()
    .then(() => updateJsonFile('package.json', json => {
      if (!json['dependencies']) {
        json['dependencies'] = {};
      }
      if (!json['devDependencies']) {
        json['devDependencies'] = {};
      }

      for (const packageName of Object.keys(packages)) {
        if (json['dependencies'].hasOwnProperty(packageName)) {
          json['dependencies'][packageName] = packages[packageName].tar;
        } else if (json['devDependencies'].hasOwnProperty(packageName)) {
          json['devDependencies'][packageName] = packages[packageName].tar;
        }
      }
    }));
}

export function useSha() {
  const argv = getGlobalVariable('argv');
  if (argv['ng-snapshots'] || argv['ng-tag']) {
    // We need more than the sha here, version is also needed. Examples of latest tags:
    // 7.0.0-beta.4+dd2a650
    // 6.1.6+4a8d56a
    const label = argv['ng-tag'] ? argv['ng-tag'] : '';
    return updateJsonFile('package.json', json => {
      // Install over the project with snapshot builds.
      Object.keys(json['dependencies'] || {})
        .filter(name => name.match(/^@angular\//))
        .forEach(name => {
          const pkgName = name.split(/\//)[1];
          if (pkgName == 'cli') {
            return;
          }
          json['dependencies'][`@angular/${pkgName}`]
            = `github:angular/${pkgName}-builds${label}`;
        });

      Object.keys(json['devDependencies'] || {})
        .filter(name => name.match(/^@angular\//))
        .forEach(name => {
          const pkgName = name.split(/\//)[1];
          if (pkgName == 'cli') {
            return;
          }
          json['devDependencies'][`@angular/${pkgName}`]
            = `github:angular/${pkgName}-builds${label}`;
        });

      json['devDependencies']['typescript'] = '~3.1.1';
    });
  } else {
    return Promise.resolve();
  }
}

export function useNgVersion(version: string) {
  return updateJsonFile('package.json', json => {
    // Install over the project with specific versions.
    Object.keys(json['dependencies'] || {})
      .filter(name => name.match(/^@angular\//))
      .forEach(name => {
        const pkgName = name.split(/\//)[1];
        if (pkgName == 'cli') {
          return;
        }
        json['dependencies'][`@angular/${pkgName}`] = version;
      });

    Object.keys(json['devDependencies'] || {})
      .filter(name => name.match(/^@angular\//))
      .forEach(name => {
        const pkgName = name.split(/\//)[1];
        if (pkgName == 'cli') {
          return;
        }
        json['devDependencies'][`@angular/${pkgName}`] = version;
      });
    // TODO: determine the appropriate version for the Angular version
    if (version.startsWith('^5')) {
      json['devDependencies']['typescript'] = '~2.5.0';
      json['dependencies']['rxjs'] = '5.5.8';
    } else {
      json['devDependencies']['typescript'] = '~2.7.0';
      json['dependencies']['rxjs'] = '6.0.0-rc.0';
    }
  });
}

export function useCIDefaults(projectName = 'test-project') {
  return updateJsonFile('angular.json', workspaceJson => {
    // Disable progress reporting on CI to reduce spam.
    const project = workspaceJson.projects[projectName];
    const appTargets = project.targets || project.architect;
    appTargets.build.options.progress = false;
    appTargets.test.options.progress = false;
    // Use the CI chrome setup in karma.
    appTargets.test.options.browsers = 'ChromeHeadlessCI';
    // Disable auto-updating webdriver in e2e.
    const e2eProject = workspaceJson.projects[projectName + '-e2e'];
    const e2eTargets = e2eProject.targets || e2eProject.architect;
    e2eTargets.e2e.options.webdriverUpdate = false;
  })
  .then(() => updateJsonFile('package.json', json => {
    // Use matching versions of Chrome and Webdriver.
    json['scripts']['webdriver-update'] = 'webdriver-manager update' +
      ` --standalone false --gecko false --versions.chrome 2.45`; // Supports Chrome v70-72

  }))
  .then(() => npm('run', 'webdriver-update'));
}

export function useCIChrome(projectDir: string) {
  const protractorConf = `${projectDir}/protractor.conf.js`;
  const karmaConf = `${projectDir}/karma.conf.js`;

  return Promise.resolve()
    .then(() => updateJsonFile('package.json', json => {
      // Use matching versions of Chrome and Webdriver.
      json['devDependencies']['puppeteer'] = '1.11.0'; // Chromium 72.0.3618.0 (r609904)
      json['devDependencies']['karma-chrome-launcher'] = '~2.2.0'; // Minimum for ChromeHeadless.
    }))
    // Use Pupeteer in protractor if a config is found on the project.
    .then(() =>  {
      if (fs.existsSync(protractorConf)) {
        return replaceInFile(protractorConf,
          `'browserName': 'chrome'`,
          `'browserName': 'chrome',
          chromeOptions: {
            args: ['--headless', '--no-sandbox', '--disable-gpu'],
            binary: require('puppeteer').executablePath()
          }
        `);
      }
    })
    // Use Pupeteer in karma if a config is found on the project.
    .then(() =>  {
      if (fs.existsSync(karmaConf)) {
        return prependToFile(karmaConf,
          `process.env.CHROME_BIN = require('puppeteer').executablePath();`)
        .then(() => replaceInFile(karmaConf,
          `browsers: ['Chrome']`,
          `browsers: ['Chrome'],
          customLaunchers: {
            ChromeHeadlessCI: {
              base: 'ChromeHeadless',
              flags: ['--no-sandbox', '--disable-gpu']
            }
          }
        `));
      }
    });
}

// Convert a Angular 5 project to Angular 2.
export function useNg2() {
  const ng2Deps: any = {
    'dependencies': {
      '@angular/common': '^2.4.0',
      '@angular/compiler': '^2.4.0',
      '@angular/core': '^2.4.0',
      '@angular/forms': '^2.4.0',
      '@angular/http': '^2.4.0',
      '@angular/platform-browser': '^2.4.0',
      '@angular/platform-browser-dynamic': '^2.4.0',
      '@angular/router': '^3.4.0',
      'zone.js': '^0.7.4'
    },
    'devDependencies': {
      '@angular/compiler-cli': '^2.4.0',
      '@types/jasmine': '~2.2.0',
      '@types/jasminewd2': undefined,
      'typescript': '~2.0.0'
    }
  };

  const tsconfigAppJson: any = {
    'compilerOptions': {
      'sourceMap': true,
      'declaration': false,
      'moduleResolution': 'node',
      'emitDecoratorMetadata': true,
      'experimentalDecorators': true,
      'target': 'es5',
      'lib': [
        'es2017',
        'dom'
      ],
      'outDir': '../out-tsc/app',
      'module': 'es2015',
      'baseUrl': '',
      'types': []
    },
    'exclude': [
      'test.ts',
      '**/*.spec.ts'
    ]
  };

  const tsconfigSpecJson: any = {
    'compilerOptions': {
      'sourceMap': true,
      'declaration': false,
      'moduleResolution': 'node',
      'emitDecoratorMetadata': true,
      'experimentalDecorators': true,
      'lib': [
        'es2017',
        'dom'
      ],
      'outDir': '../out-tsc/spec',
      'module': 'commonjs',
      'target': 'es5',
      'baseUrl': '',
      'types': [
        'jasmine',
        'node'
      ]
    },
    'files': [
      'test.ts'
    ],
    'include': [
      '**/*.spec.ts',
      '**/*.d.ts'
    ]
  };

  const tsconfigE2eJson: any = {
    'compilerOptions': {
      'sourceMap': true,
      'declaration': false,
      'moduleResolution': 'node',
      'emitDecoratorMetadata': true,
      'experimentalDecorators': true,
      'lib': [
        'es2017'
      ],
      'outDir': '../out-tsc/e2e',
      'module': 'commonjs',
      'target': 'es5',
      'types': [
        'jasmine',
        'node'
      ]
    }
  };


  return Promise.resolve()
    .then(() => updateJsonFile('package.json', json => {
      Object.keys(ng2Deps['dependencies']).forEach(pkgName => {
        json['dependencies'][pkgName] = ng2Deps['dependencies'][pkgName];
      });
      Object.keys(ng2Deps['devDependencies']).forEach(pkgName => {
        json['devDependencies'][pkgName] = ng2Deps['devDependencies'][pkgName];
      });
      console.log(JSON.stringify(json));
    }))
    .then(() => updateJsonFile('src/tsconfig.app.json', json =>
      Object.assign(json, tsconfigAppJson)))
    .then(() => updateJsonFile('src/tsconfig.spec.json', json =>
      Object.assign(json, tsconfigSpecJson)))
    .then(() => updateJsonFile('e2e/tsconfig.e2e.json', json =>
      Object.assign(json, tsconfigE2eJson)))
    .then(() => replaceInFile('src/test.ts', 'import \'zone.js/dist/zone-testing\';', `
      import 'zone.js/dist/long-stack-trace-zone';
      import 'zone.js/dist/proxy.js';
      import 'zone.js/dist/sync-test';
      import 'zone.js/dist/jasmine-patch';
      import 'zone.js/dist/async-test';
      import 'zone.js/dist/fake-async-test';
    `));
}

// Convert a Angular 5 project to Angular 4.
export function useNg4() {
  const ng4Deps: any = {
    'dependencies': {
      '@angular/common': '^4.4.6',
      '@angular/compiler': '^4.4.6',
      '@angular/core': '^4.4.6',
      '@angular/forms': '^4.4.6',
      '@angular/http': '^4.4.6',
      '@angular/platform-browser': '^4.4.6',
      '@angular/platform-browser-dynamic': '^4.4.6',
      '@angular/router': '^4.4.6',
      'zone.js': '^0.8.14'
    },
    'devDependencies': {
      '@angular/compiler-cli': '^4.4.6',
      'typescript': '~2.3.3'
    }
  };


  return Promise.resolve()
    .then(() => updateJsonFile('package.json', json => {
      Object.keys(ng4Deps['dependencies']).forEach(pkgName => {
        json['dependencies'][pkgName] = ng4Deps['dependencies'][pkgName];
      });
      Object.keys(ng4Deps['devDependencies']).forEach(pkgName => {
        json['devDependencies'][pkgName] = ng4Deps['devDependencies'][pkgName];
      });
      console.log(JSON.stringify(json));
    }));
}
