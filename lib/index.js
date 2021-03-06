/* eslint-disable no-unused-vars */
var fs = require('fs'),
    path = require('path'),
    _ = require('lodash'),
    handlebars = require('handlebars'),
    helpers = require('handlebars-helpers')({
        handlebars: handlebars
    }),

    util = require('./util'),

    /**
 * An object of the default file read preferences.
 *
 * @type {Object}
 */
    FILE_READ_OPTIONS = { encoding: 'utf8' },

    /**
 * The default Handlebars template to use when no user specified template is provided.
 *
 * @type {String}
 */
    DEFAULT_TEMPLATE = 'dashboard-template.hbs',

    /**
 * The list of execution data fields that are aggregated over multiple requests for the collection run
 *
 * @type {String[]}
 */
    AGGREGATED_FIELDS = ['cursor', 'item', 'request', 'response', 'requestError'],

    PostmanHTMLExtraReporter;

/**
 * A function that creates raw markup to be written to Newman HTML reports.
 *
 * @param {Object} newman - The collection run object, with a event handler setter, used to enable event wise reporting.
 * @param {Object} options - The set of HTML reporter run options.
 * @param {String=} options.template - Optional path to the custom user defined HTML report template (Handlebars).
 * @param {String=} options.export - Optional custom path to create the HTML report at.
 * @param {Object} collectionRunOptions - The set of all the collection run options.
 * @returns {*}
 */
PostmanHTMLExtraReporter = function (newman, options, collectionRunOptions) {
    // Helper for calculating pass percentage
    handlebars.registerHelper('percent', function (passed, failed) {
        return (passed * 100 / (passed + failed)).toFixed(0);
    });
    // increment helper for zero index
    handlebars.registerHelper('inc', function (value) {
        return parseInt(value) + 1;
    });
    // Sums the total tests by 'assertions - skipped tests'
    handlebars.registerHelper('totalTests', function (assertions, skippedTests) {
        return skippedTests ? parseInt(assertions) - parseInt(skippedTests) : parseInt(assertions);
    });
    // Adds the moment helper module
    handlebars.registerHelper('moment', require('helper-moment'));

    // @todo throw error here or simply don't catch them and it will show up as warning on newman
    var htmlTemplate = options.template || path.join(__dirname, DEFAULT_TEMPLATE),
        compiler = handlebars.compile(fs.readFileSync(htmlTemplate, FILE_READ_OPTIONS));

    // Handle the skipped tests
    newman.on('assertion', function (err, o) {
        if (err) { return; }

        if (o.skipped) {
            this.summary.skippedTests = this.summary.skippedTests || [];

            this.summary.skippedTests.push({
                cursor: {
                    ref: o.cursor.ref,
                    iteration: o.cursor.iteration,
                    scriptId: o.cursor.scriptId
                },
                assertion: o.assertion,
                skipped: o.skipped,
                error: o.error,
                item: {
                    id: o.item.id,
                    name: o.item.name
                }
            });
        }
    });

    // First attempt at exposing the Console Logs

    newman.on('console', function (err, o) {
        if (err) { return; }

        this.summary.consoleLogs = this.summary.consoleLogs || [];

        this.summary.consoleLogs.push({
            cursor: {
                ref: o.cursor.ref,
                iteration: o.cursor.iteration,
                scriptId: o.cursor.scriptId
            },
            level: o.level,
            messages: o.messages
        });
    });

    newman.on('beforeDone', function () {
        var items = {},
            executionMeans = {},
            netTestCounts = {},
            aggregations = [],
            traversedRequests = {},
            aggregatedExecutions = {},
            executions = _.get(this, 'summary.run.executions'),
            assertions = _.transform(executions, function (result, currentExecution) {
                var stream,
                    reducedExecution,
                    executionId = currentExecution.cursor.ref;

                if (!_.has(traversedRequests, executionId)) {
                    // mark the current request instance as traversed
                    _.set(traversedRequests, executionId, 1);

                    // set the base assertion and cumulative test details for the current request instance
                    _.set(result, executionId, {});
                    _.set(netTestCounts, executionId, { passed: 0, failed: 0, skipped: 0 });

                    // set base values for overall response size and time values
                    _.set(executionMeans, executionId, { time: { sum: 0, count: 0 }, size: { sum: 0, count: 0 } });

                    reducedExecution = _.pick(currentExecution, AGGREGATED_FIELDS);

                    if (reducedExecution.response && _.isFunction(reducedExecution.response.toJSON)) {
                        reducedExecution.response = reducedExecution.response.toJSON();
                        stream = reducedExecution.response.stream;
                        reducedExecution.response.body = Buffer.from(stream).toString();
                    }

                    // set sample request and response details for the current request
                    items[reducedExecution.cursor.ref] = reducedExecution;
                }

                executionMeans[executionId].time.sum += _.get(currentExecution, 'response.responseTime', 0);
                executionMeans[executionId].size.sum += _.get(currentExecution, 'response.responseSize', 0);

                ++executionMeans[executionId].time.count;
                ++executionMeans[executionId].size.count;

                _.forEach(currentExecution.assertions, function (assertion) {
                    var aggregationResult,
                        assertionName = assertion.assertion,
                        isError = _.get(assertion, 'error') !== undefined,
                        isSkipped = _.get(assertion, 'skipped');

                    result[executionId][assertionName] = result[executionId][assertionName] || {
                        name: assertionName,
                        passed: 0,
                        failed: 0,
                        skipped: 0
                    };
                    aggregationResult = result[executionId][assertionName];

                    if (isError && isSkipped !== true) {
                        aggregationResult.failed++;
                        netTestCounts[executionId].failed++;
                    }
                    else if (isSkipped) {
                        aggregationResult.skipped++;
                        netTestCounts[executionId].skipped++;
                    }
                    else if (isError === false && isSkipped === false) {
                        aggregationResult.passed++;
                        netTestCounts[executionId].passed++;
                    }
                });
            }, {}),

            aggregator = function (execution) {
                // fetch aggregated run times and response sizes for items, (0 for failed requests)
                var aggregationMean = executionMeans[execution.cursor.ref],
                    meanTime = _.get(aggregationMean, 'time', 0),
                    meanSize = _.get(aggregationMean, 'size', 0),
                    parent = execution.item.parent(),
                    iteration = execution.cursor.iteration,
                    previous = _.last(aggregations),
                    current = _.merge(items[execution.cursor.ref], {
                        assertions: _.values(assertions[execution.cursor.ref]),
                        mean: {
                            time: util.prettyms(meanTime.sum / meanTime.count),
                            size: util.filesize(meanSize.sum / meanSize.count)
                        },
                        cumulativeTests: netTestCounts[execution.cursor.ref]
                    });

                if (aggregatedExecutions[execution.cursor.ref]) { return; }

                aggregatedExecutions[execution.cursor.ref] = true;

                if (previous && parent.id === previous.parent.id) {
                    previous.executions.push(current);
                }
                else {
                    aggregations.push({
                        parent: {
                            id: parent.id,
                            name: util.getFullName(parent),
                            description: parent.description,
                            iteration: iteration
                        },
                        executions: [current]
                    });
                }
            };

        _.forEach(this.summary.run.executions, aggregator);

        this.exports.push({
            name: 'html-reporter-htmlextra',
            default: 'newman-run-report-htmlextra.html',
            path: options.export,
            content: compiler({
                timestamp: Date(),
                version: collectionRunOptions.newmanVersion,
                aggregations: aggregations,
                summary: {
                    stats: this.summary.run.stats,
                    collection: this.summary.collection,
                    globals: _.isObject(this.summary.globals) ? this.summary.globals : undefined,
                    environment: _.isObject(this.summary.environment) ? this.summary.environment : undefined,
                    failures: this.summary.run.failures,
                    responseTotal: util.filesize(this.summary.run.transfers.responseTotal),
                    responseAverage: util.prettyms(this.summary.run.timings.responseAverage),
                    duration: util.prettyms(this.summary.run.timings.completed - this.summary.run.timings.started),
                    skippedTests: _.isObject(this.summary.skippedTests) ? this.summary.skippedTests : undefined,
                    consoleLogs: _.isObject(this.summary.consoleLogs) ? this.summary.consoleLogs : undefined
                }
            })
        });
    });
};

module.exports = PostmanHTMLExtraReporter;
