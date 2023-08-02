/* eslint-disable */

import junit from 'junit-report-builder';
import WDIOReporter from '@wdio/reporter';
const FILE_PROTOCOL_REGEX = /^file:\/\//;
import { limit } from './utils.js';
const ansiRegex = new RegExp(
    [
        '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
        '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
    ].join('|'),
    'g',
);
/**
 * Reporter that converts test results from a single instance/runner into an XML JUnit report. This class
 * uses junit-report-builder (https://github.com/davidparsson/junit-report-builder) to build report.The report
 * generated from this reporter should conform to the standard JUnit report schema
 * (https://github.com/junit-team/junit5/blob/master/platform-tests/src/test/resources/jenkins-junit.xsd).
 */
class JunitReporter extends WDIOReporter {
    options;
    _suiteNameRegEx;
    _packageName;
    _suiteTitleLabel;
    _fileNameLabel;
    _activeFeature;
    _activeFeatureName;
    constructor(options) {
        super(options);
        this.options = options;
        this._suiteNameRegEx =
            this.options.suiteNameFormat instanceof RegExp
                ? this.options.suiteNameFormat
                : /[^a-zA-Z0-9@]+/; // Reason for ignoring @ is; reporters like wdio-report-portal will fetch the tags from testcase name given as @foo @bar
    }
    onTestRetry(testStats) {
        testStats.skip('Retry');
    }
    onRunnerEnd(runner) {
        const xml = this._buildJunitXml(runner);
        this.write(xml);
    }
    _prepareName(name = 'Skipped test') {
        return name
            .split(this._suiteNameRegEx)
            .filter((item) => item && item.length)
            .join(' ');
    }
    _addFailedHooks(suite) {
        /**
         * Add failed hooks to suite as tests.
         */
        const failedHooks = suite.hooks.filter(
            (hook) => hook.error && hook.title.match(/^"(before|after)( all| each)?" hook/),
        );
        failedHooks.forEach((hook) => {
            const { title, _duration, error, state } = hook;
            suite.tests.push({
                _duration,
                title,
                error,
                state: state,
                output: [],
            });
        });
        return suite;
    }

    _addSuiteToBuilder(builder, runner, specFileName, suite) {
        const filePath = specFileName.replace(process.cwd(), '.');
        const suiteName =
            !this.options.suiteNameFormat || this.options.suiteNameFormat instanceof RegExp
                ? this._prepareName(suite.title)
                : this.options.suiteNameFormat({ name: this.options.suiteNameFormat.name, suite });
        const testSuite = builder
            .testSuite()
            .name(suiteName)
            .timestamp(suite.start)
            .time(suite._duration / 1000)
            .property('specId', 0)
            .property(this._suiteTitleLabel, suite.title)
            .property('capabilities', runner.sanitizedCapabilities)
            .property(this._fileNameLabel, filePath);

        suite = this._addFailedHooks(suite);

        const classNameFormat = this.options.classNameFormat
            ? this.options.classNameFormat({ packageName: this._packageName, suite })
            : `${this._packageName}.${(suite.fullTitle || suite.title).replace(/\s/g, '_')}`;

        const testCase = testSuite
            .testCase()
            .className(classNameFormat)
            .name(suiteName)
            .time(suite._duration / 1000);

        if (this.options.addFileAttribute) {
            testCase.file(filePath);
        }
        for (const testKey of Object.keys(suite.tests)) {
            if (testKey === 'undefined') {
                // fix cucumber hooks crashing reporter (INFO: we may not need this anymore)
                continue;
            }
            const test = suite.tests[testKey];

            if (test.state === 'pending' || test.state === 'skipped') {
                testCase.skipped();
            } else if (test.state === 'failed') {
                if (test.error) {
                    if (test.error.message) {
                        test.error.message = test.error.message.replace(ansiRegex, '');
                    }
                    if (this.options.errorOptions) {
                        const errorOptions = this.options.errorOptions;
                        for (const key of Object.keys(errorOptions)) {
                            testCase[key](test.error[errorOptions[key]]);
                        }
                    } else {
                        // default
                        testCase.error(test.error.message);
                    }
                } else {
                    testCase.error();
                }
                testCase.failure();
            }
        }
        return builder;
    }
    _buildJunitXml(runner) {
        const builder = junit.newBuilder();
        if (
            runner.config.hostname !== undefined &&
            runner.config.hostname.indexOf('browserstack') > -1
        ) {
            // NOTE: deviceUUID is used to build sanitizedCapabilities resulting in a ever-changing package name in runner.sanitizedCapabilities when running Android tests under Browserstack. (i.e. ht79v1a03938.android.9)
            // NOTE: platformVersion is used to build sanitizedCapabilities which can be incorrect and includes a minor version for iOS which is not guaranteed to be the same under Browserstack.
            const browserstackSanitizedCapabilities =
                [
                    runner.capabilities.device,
                    runner.capabilities.os,
                    (runner.capabilities.os_version || '').replace(/\./g, '_'),
                ]
                    .filter(Boolean)
                    .map((capability) => capability.toLowerCase())
                    .join('.')
                    .replace(/ /g, '') || runner.sanitizedCapabilities;
            this._packageName = this.options.packageName || browserstackSanitizedCapabilities;
        } else {
            this._packageName = this.options.packageName || runner.sanitizedCapabilities;
        }
        const isCucumberFrameworkRunner = runner.config.framework === 'cucumber';
        if (isCucumberFrameworkRunner) {
            this._packageName = `CucumberJUnitReport-${this._packageName}`;
            this._suiteTitleLabel = 'featureName';
            this._fileNameLabel = 'featureFile';
        } else {
            this._suiteTitleLabel = 'suiteName';
            this._fileNameLabel = 'file';
        }
        runner.specs.forEach((specFileName) => {
            if (isCucumberFrameworkRunner) {
                this._buildOrderedReport(
                    builder,
                    runner,
                    specFileName,
                    'feature',
                    isCucumberFrameworkRunner,
                );
                this._buildOrderedReport(
                    builder,
                    runner,
                    specFileName,
                    'scenario',
                    isCucumberFrameworkRunner,
                );
            } else {
                this._buildOrderedReport(
                    builder,
                    runner,
                    specFileName,
                    '',
                    isCucumberFrameworkRunner,
                );
            }
        });
        return builder.build();
    }
    _buildOrderedReport(builder, runner, specFileName, type, isCucumberFrameworkRunner) {
        for (const suiteKey of Object.keys(this.suites)) {
            /**
             * ignore root before all
             */
            /* istanbul ignore if  */
            if (suiteKey.match(/^"before all"/)) {
                continue;
            }
            const suite = this.suites[suiteKey];
            const sameFeature =
                isCucumberFrameworkRunner &&
                specFileName.replace(FILE_PROTOCOL_REGEX, '') ===
                    suite.file.replace(FILE_PROTOCOL_REGEX, '');
            if (isCucumberFrameworkRunner && suite.type === type && sameFeature) {
                builder = this._addCucumberFeatureToBuilder(builder, runner, specFileName, suite);
            } else if (!isCucumberFrameworkRunner) {
                builder = this._addSuiteToBuilder(builder, runner, specFileName, suite);
            }
        }
        return builder;
    }
    _getStandardOutput(test) {
        const standardOutput = [];
        test.output.forEach((data) => {
            switch (data.type) {
                case 'command':
                    standardOutput.push(
                        data.method
                            ? `COMMAND: ${data.method.toUpperCase()} ` +
                                  `${data.endpoint.replace(
                                      ':sessionId',
                                      data.sessionId,
                                  )} - ${this._format(data.body)}`
                            : `COMMAND: ${data.command} - ${this._format(data.params)}`,
                    );
                    break;
                case 'result':
                    standardOutput.push(`RESULT: ${this._format(data.body)}`);
                    break;
            }
        });
        return standardOutput.length ? standardOutput.join('\n') : '';
    }
    _format(val) {
        return JSON.stringify(limit(val));
    }
}
export default JunitReporter;
