//  sigfox-gcloud is a framework for building a Sigfox server, based
//  on Google Cloud Functions.  Here are the common functions used by
//  Google Cloud Functions.  They should also work with Linux, MacOS
//  and Ubuntu on Windows for unit test.

/* eslint-disable camelcase, no-console, no-nested-ternary, global-require, import/no-unresolved, max-len */
//  This is needed because Node.js doesn't cache DNS lookups and will cause DNS quota to be exceeded
//  in Google Cloud.
require('dnscache')({ enable: true });

//  If the file .env exists in the current folder, use it to populate
//  the environment variables e.g. GCLOUD_PROJECT=myproject
require('dotenv').load();

//  Don't require any other Google Cloud modules in global scope
//  because the connections may expire when running for a long time
//  in Google Cloud Functions.

//  Environment variable GCLOUD_PROJECT must be set to your Google Cloud
//  project ID e.g. export GCLOUD_PROJECT=myproject
const projectId = process.env.GCLOUD_PROJECT;    //  Google Cloud project ID.
const functionName = process.env.FUNCTION_NAME || 'unknown_function';
const isCloudFunc = !!process.env.FUNCTION_NAME || !!process.env.GAE_SERVICE;  //  True if running in Google Cloud.
const isProduction = (process.env.NODE_ENV === 'production');  //  True on production server.
const uuidv4 = require('uuid/v4');
const path = require('path');
const isCircular = require('is-circular');

//  Assume that the Google Service Account credentials are present in this file.
//  This is needed for calling Google Cloud PubSub, Logging, Trace, Debug APIs
//  on Linux / MacOS / Ubuntu on Windows.  Assume it's in the main folder for the app.
const keyFilename = path.join(process.cwd(), 'google-credentials.json');
//  If we are running in the Google Cloud, no credentials necessary.
const googleCredentials = isCloudFunc ? null : { projectId, keyFilename };
const logName = 'sigfox-gcloud';  //  Name of the log to write to.

function removeNulls(obj0, level) {
  //  Remove null values recursively.  Skip circular references.
  if (level > 3) return '(truncated)';
  const obj = Object.assign({}, obj0);
  for (const key of Object.keys(obj)) {
    //  console.log({ key });
    const val = obj[key];
    if (val === null || val === undefined) {
      delete obj[key];
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      //  Val is a non-array object.
      let circular = true;
      try {
        circular = isCircular(val);
        // eslint-disable-next-line no-empty
      } catch (err) {}
      if (circular) {
        //  Remove circular references.
        delete obj[key];
        console.error(`Dropped circular reference ${key}`);
        continue;
      }
      obj[key] = removeNulls(val, (level || 0) + 1);
    }
  }
  return obj;
}

function createTraceID(now0) {
  //  Return a trace ID array with local time MMSS-uuid to sort in Firebase.
  const now = now0 || Date.now();
  const s = new Date(now + (8 * 60 * 60 * 1000 * 100)).toISOString();
  return [`${s.substr(14, 2)}${s.substr(17, 2)}-${uuidv4()}`];
}

function logQueue(req, action, para0) { /* eslint-disable global-require, no-param-reassign */
  //  Write log to UnaAppLogger and BigQuery for easier analysis.
  try {
    const now = Date.now();
    if (!req) req = {};
    if (!para0) para0 = {};
    if (!req.traceid) req.traceid = createTraceID(now);
    //  Compute the duration in seconds with 1 decimal place.
    if (req.starttime) para0.duration = parseInt((now - req.starttime) / 100, 10) / 10.0;
    else req.starttime = now;
    const starttime = req.starttime;
    const traceid = req.traceid;

    //  Extract the log fields.
    let userid = null;
    let companyid = null;
    let token = null;
    if (req.userid) userid = req.userid;
    if (req.companyid) companyid = req.companyid;
    if (req && req.get) token = req.get('Authorization') || req.get('token');
    if (token && token.length >= 20) token = `${token.substr(0, 20)}...`;
    const para = removeNulls(para0);

    //  Write the log to pubsub queues.  Each config contains { projectId, topicName }
    const msg = { timestamp: now, starttime, traceid, userid, companyid, token, action, para };
    let promises = Promise.resolve('start');
    const result = [];
    module.exports.logQueueConfig.forEach((config) => {
      //  Create pubsub client upon use to prevent expired connection.
      const credentials = Object.assign({}, googleCredentials,
        { projectId: config.projectId });
      const topic = require('@google-cloud/pubsub')(credentials)
        .topic(config.topicName);
      promises = promises
        .then(() => topic.publish(msg))
        //  Suppress any errors so logging can continue.
        .catch((err) => { console.error(config, err.message, err.stack); return err; })
        .then((res) => { result.push(res); });
    });
    return promises //  Suppress any errors.
      .catch((err) => { console.error(err.message, err.stack); return err; })
      .then(() => result);
  } catch (err) {
    console.error(err.message, err.stack);
    return Promise.resolve(err);
  }
} /* eslint-enable global-require, no-param-reassign */

/* eslint-disable no-underscore-dangle, import/newline-after-import, no-param-reassign */
function log(req, action0, para0) {
  //  Write the action and parameters to Google Cloud Logging for normal log,
  //  or to Google Cloud Error Reporting if para contains error.
  //  Returns a promise for the error, if it exists, or the result promise,
  //  else null promise. req contains the Express or PubSub request info.
  //  Don't log any null values, causes Google Log errors.
  try {
    //  Text timestamp works with InfluxDB but not consistent with Express logger.
    const now = Date.now();
    if (!req) req = {};
    if (!para0) para0 = {};
    const err = para0.err || para0.error || null;

    if (!req.traceid) req.traceid = createTraceID(now);
    //  Compute the duration in seconds with 1 decimal place.
    if (req.starttime) para0.duration = parseInt((now - req.starttime) / 100, 10) / 10.0;
    else req.starttime = now;
    if (err && isProduction) {
      try {
        //  Report the error to the Stackdriver Error Reporting API
        const errorReport = require('@google-cloud/error-reporting')({ reportUnhandledRejections: true });

        errorReport.report(err);
      } catch (err2) { console.error(err2.message, err2.stack); }
    }
    //  Don't log any null values, causes Google Log errors.
    const para = removeNulls(para0);
    const action = [functionName, action0].join('/');  //  Prefix action by function name.
    const level = err ? 'ERROR' : 'DEBUG';
    //  Write to UnaAppLogger for easier analysis.
    logQueue(req, action, para);

    const metadata = {
      severity: level.toUpperCase(),
      resource: {
        type: 'cloud_function',
        labels: { function_name: functionName },
      } };
    const event = {};
    //  Else log to Google Cloud Logging. We use _ and __ because
    //  it delimits the action and parameters nicely in the log.
    event.__ = action || '';
    event._ = para || '';
    if (!isCloudFunc) {
      const out = [action, require('util').inspect(para, { colors: true })].join(' | ');
      console.log(out);
    }
    //  Write the log.  Create logging client here to prevent expired connection.
    const logging = require('@google-cloud/logging')(googleCredentials);
    const loggingLog = logging.log(logName);
    return loggingLog.write(loggingLog.entry(metadata, event))
      .catch(err2 => console.error(err2.message, err2.stack))
      //  If error return the error. Else return the result or null.
      .then(() => (err || para.result || null));
  } catch (error) {
    console.error(error.message, error.stack);
    return para0 ? (para0.err || para0.error || para0.result || null) : null;
  }
} /* eslint-enable no-underscore-dangle, import/newline-after-import, no-param-reassign */

//  TODO
function isProcessedMessage(/* req, message */) {
  //  Return true if this message is being or has been processed recently by this server
  //  or another server.  We check the central queue.  In case of error return false.
  //  Returns a promise.
  return Promise.resolve(false);  //  TODO
}

function publishMessage(req, oldMessage, device, type) {
  //  Publish the message to the device or message type queue in PubSub.
  //  If device is non-null, publish to sigfox.devices.<<device>>
  //  If type is non-null, publish to sigfox.types.<<type>>
  //  If message contains options.unpackBody=true, then send message.body as the root of the
  //  message.  This is used for sending log messages to BigQuery via Google Cloud DataFlow.
  //  The caller must have called server/bigquery/validateLogSchema.
  //  Returns a promise for the PubSub topic.publish result.
  const topicName0 = device
    ? `sigfox.devices.${device}`
    : type
      ? `sigfox.types.${type}`
      : 'sigfox.devices.missing_device';
  const credentials0 = Object.assign({}, googleCredentials);
  const res = module.exports.transformRoute(req, type, device, credentials0, topicName0);
  const credentials = res.credentials;
  const topicName = res.topicName;
  //  Create pubsub client here to prevent expired connection.
  const topic = require('@google-cloud/pubsub')(credentials).topic(topicName);

  let message = Object.assign({}, oldMessage,
    device ? { device: (device === 'all') ? oldMessage.device : device }
      : type ? { type }
      : { device: 'missing_device' });
  if (device === 'all') message.device = oldMessage.device;

  //  If message contains options.unpackBody=true, then send message.body as the root of the
  //  message.  This is used for sending log messages to BigQuery via Google Cloud DataFlow.
  //  The caller must have called server/bigquery/validateLogSchema.
  if (message.options && message.options.unpackBody) {
    message = message.body;
  }
  const destination = topicName;
  return topic.publish(message)
    .then(result => log(req, 'publishMessage',
      { result, destination, topicName, message, device, type, projectId: credentials.projectId || '' }))
    .catch(error => log(req, 'publishMessage',
      { error, destination, topicName, message, device, type, projectId: credentials.projectId || '' }));
}

function updateMessageHistory(req, oldMessage) {
  //  Update the message history in the message. Records the duration that
  //  was spent processing this request, also latency of message delivery.
  //  Message history is an array of records, from earliest to latest:
  //  [ { timestamp, end, duration, latency, source, function }, ... ]
  //  Source is the message queue that supplied the message:
  //  e.g. projects/myproject/topics/sigfox.devices.all
  //  Duration and latency are in seconds.
  //  Returns the updated clone of the message.
  const message = Object.assign({}, oldMessage);  //  Clone the message.
  if (!message.history) message.history = [];
  const timestamp = req.starttime;
  const end = Date.now();
  //  Compute the duration in seconds with 1 decimal place.
  const duration = timestamp ? (parseInt((end - timestamp) / 100, 10) / 10.0) : 0;
  //  Compute the latency between queues in second with 1 decimal place.
  const lastSend = (message.history.length > 0)
    ? message.history[message.history.length - 1].end
    : null;  //  Get the last send time.
  const latency = lastSend ? (parseInt((timestamp - lastSend) / 100, 10) / 10.0) : 0;
  //  Source looks like projects/myproject/topics/sigfox.devices.all
  const source = (req && req.event) ? req.event.resource : req.path;
  const rec = {
    timestamp,
    end,
    duration,
    latency,
    source,
    function: functionName,
  };
  message.history.push(rec);
  return message;
}

function dispatchMessage(req, oldMessage, device) {
  //  Dispatch the message to the next step in the route of the message.
  //  message contains { device, type, body, query, route }
  //  route looks like [ messagetype1, messagetype2, ... ]
  //  Returns a promise for the updated message.  Caller must have set
  //  const req = { starttime: Date.now(), event };

  //  If already dispatched, return.
  if (oldMessage.isDispatched) return Promise.resolve(oldMessage);
  //  Update the message history.
  const message = updateMessageHistory(req, oldMessage);
  if (!message.route || message.route.length === 0) {
    //  No more steps to dispatch, quit.
    const result = message;
    log(req, 'dispatchMessage', { result, status: 'no_route', message, device });
    return Promise.resolve(result);
  }
  //  Get the next step and publish the message there.
  //  Don't use shift() because it mutates the original object:
  //  const type = msg.route.shift();
  message.type = message.route[0];
  message.route = message.route.slice(1);
  const type = message.type;
  const route = message.route;
  const destination = type;
  const result = message;
  return publishMessage(req, message, null, type)
    .then(res => log(req, 'dispatchMessage',
      { result, destination, res, route, message, device, type }))
    .catch(error => log(req, 'dispatchMessage',
      { error, destination, route, message, device, type }))
    .then(() => result);
}


function runTask(req, event, task, device, body, message) {
  //  The task is the pluggable function, provided by the caller,
  //  that will perform a single step of Sigfox message processing
  //  e.g. decodeStructuredMessage, logToGoogleSheets.
  //  Wait for the task to complete then dispatch to next step.
  //  Returns a promise for the dispatched message.
  let updatedMessage = message;
  return task(req, device, body, message)
    .then(result => log(req, 'result', { result, device, body, event, message }))
    .then((result) => { updatedMessage = result; return result; })
    .catch(error => log(req, 'failed', { error, device, body, event, message }))
    .then(() => dispatchMessage(req, updatedMessage, device))
    .catch((error) => { throw error; });
}

function main(event, task) {
  //  Start point for the Cloud Function, which is triggered by the delivery
  //  of a PubSub message. Decode the Sigfox message and perform the task specified
  //  by the caller to process the Sigfox message.  Then dispatch the next step of
  //  the route in the message, set by routeMessage.
  //  task should have the signature task(req, device, body, message).
  //  event contains
  //  { eventType: "providers/cloud.pubsub/eventTypes/topic.publish"
  //    resource: "projects/myproject/topics/sigfox.devices.all"
  //    timestamp: "2017-05-06T10:19:29.666Z"
  //    data: {…}  //  Base64 encoded Sigfox message
  //    eventId: "120816659675797" }
  const req = { starttime: Date.now(), event };  //  Record start time.
  //  Decode the base64 message.
  const message = JSON.parse(Buffer.from(event.data.data, 'base64').toString());
  const device = message ? message.device : null;
  const body = message ? message.body : null;
  req.uuid = body ? body.uuid : 'missing_uuid';
  if (message.isDispatched) delete message.isDispatched;
  log(req, 'start', { device, body, event, message });

  //  If the message is already processed by another server, skip it.
  return isProcessedMessage(req, message)
    .then(isProcessed => (
      isProcessed
        ? log(req, 'skip', { result: message, isProcessed, device, body, event, message })
        //  Else wait for the task to complete then dispatch the next step.
        : runTask(req, event, task, device, body, message)
    ))
    //  Log the final result i.e. the dispatched message.
    .then(result => log(req, 'end', { result, device, body, event, message }))
    //  Suppress all errors else Google will retry the message.
    .catch(error => log(req, 'end', { error, device, body, event, message }));
}

module.exports = {
  projectId,
  functionName,
  log,
  error: log,
  logQueueConfig: [],   //  Log to BigQuery via PubSub: array of { projectId, topicName }
  logQueue,
  publishMessage,
  updateMessageHistory,
  dispatchMessage,
  main,
  //  If required, remap the projectId and topicName to deliver to another queue.
  transformRoute: (req, type, device, credentials, topicName) =>
    ({ credentials, topicName }),
};


