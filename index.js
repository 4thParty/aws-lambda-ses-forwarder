"use strict";

var AWS = require('aws-sdk');

var airTable = require('./AirTable');
const Slack = require('./Slack');

const emojiInfo = ':information_source:';

const isHostedOnAWS = !!(process.env.LAMBDA_TASK_ROOT || process.env.AWS_EXECUTION_ENV);

console.log("AWS Lambda SES Forwarder // @arithmetric // Version 5.0.0");

// Configure the S3 bucket and key prefix for stored raw emails, and the
// mapping of email addresses to forward from and to.
//
// Expected keys/values:
//
// - fromEmail: Forwarded emails will come from this verified address
//
// - subjectPrefix: Forwarded emails subject will contain this prefix
//
// - emailBucket: S3 bucket name where SES stores emails.
//
// - inboundEmailKeyPrefix: S3 key name prefix where SES stores email. Include the
//   trailing slash.
//
// - allowPlusSign: Enables support for plus sign suffixes on email addresses.
//   If set to `true`, the username/mailbox part of an email address is parsed
//   to remove anything after a plus sign. For example, an email sent to
//   `example+test@example.com` would be treated as if it was sent to
//   `example@example.com`.
//
// - forwardMapping: Object where the key is the lowercase email address from
//   which to forward and the value is an array of email addresses to which to
//   send the message.
//
//   To match all email addresses on a domain, use a key without the name part
//   of an email address before the "at" symbol (i.e. `@example.com`).
//
//   To match a mailbox name on all domains, use a key without the "at" symbol
//   and domain part of an email address (i.e. `info`).
//
//   To match all email addresses matching no other mapping, use "@" as a key.
var defaultConfig = {
  fromEmail: "outbound@forwarder.billhero.com.au",
  subjectPrefix: "[Forwarded via Bill Hero] - ",
  emailBucket: "billhero-email",
  inboundEmailKeyPrefix: "inbound/",
  outboundEmailKeyPrefix: "outbound/",
  allowPlusSign: false,
  abortSubject: /Delivery Status Notification \(Failure\)/i,
  forwardMapping: {
    "@forwarder.billhero.com.au": [
      // "richard+test-bh-inbound@foxworthy.name",
    ],
  }
};

/**
 * Parses the SES event record provided for the `mail` and `receipients` data.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.parseEvent = function(data) {
  if (data.abortReason) return Promise.resolve(data);

  // Validate characteristics of a SES event record.
  if (!data.event ||
      !data.event.hasOwnProperty('Records') ||
      data.event.Records.length !== 1 ||
      !data.event.Records[0].hasOwnProperty('eventSource') ||
      data.event.Records[0].eventSource !== 'aws:ses' ||
      data.event.Records[0].eventVersion !== '1.0') {
    data.log({
      message: "parseEvent() received invalid SES message:",
      level: "error", event: JSON.stringify(data.event)
    });
    return Promise.reject(new Error('Error: Received invalid SES message.'));
  }

  data.email = data.event.Records[0].ses.mail;
  data.recipients = data.event.Records[0].ses.receipt.recipients;
  return Promise.resolve(data);
};

/**
 * Transforms the original recipients to the desired forwarded destinations.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.transformRecipients = async (data) => {
  if (data.abortReason) return Promise.resolve(data);

  var newRecipients = [];
  data.originalRecipients = data.recipients;
  for (var origEmail of data.recipients) {
    // Momentum (and possibly others) require an email prefix of 'subscriber+'.
    // We need to get rid of it.
    origEmail.replace(/^subscriber(\+|%2b)/mgi, ''); 
    var origEmailKey = origEmail.toLowerCase();
    if (data.config.allowPlusSign) {
      origEmailKey = origEmailKey.replace(/\+.*?@/, '@');
    }
    if (data.config.forwardMapping.hasOwnProperty(origEmailKey)) {
      newRecipients = newRecipients.concat(
        data.config.forwardMapping[origEmailKey]);
      data.originalRecipient = origEmail;
    } else {
      var origEmailDomain;
      var origEmailUser;
      var origEmailUserOrigCase;
      var pos = origEmailKey.lastIndexOf("@");
      if (pos === -1) {
        origEmailUser = origEmailKey;
      } else {
        origEmailDomain = origEmailKey.slice(pos);
        origEmailUser = origEmailKey.slice(0, pos);
        origEmailUserOrigCase = origEmail.slice(0, pos);
      }
      if (origEmailDomain &&
        data.config.forwardMapping.hasOwnProperty(origEmailDomain)) {
        var found = await airTable.lookupUser(origEmailUserOrigCase);

        if (found) {
          /* newRecipients = newRecipients.concat(
            data.config.forwardMapping[origEmailDomain]);
          */
          newRecipients = newRecipients.concat(found);
          data.billHeroToAddress = found;
        }
        data.originalRecipient = origEmail;
      } else if (origEmailUser &&
        data.config.forwardMapping.hasOwnProperty(origEmailUser)) {
        newRecipients = newRecipients.concat(
          data.config.forwardMapping[origEmailUser]);
        data.originalRecipient = origEmail;
      } else if (data.config.forwardMapping.hasOwnProperty("@")) {
        newRecipients = newRecipients.concat(
          data.config.forwardMapping["@"]);
        data.originalRecipient = origEmail;
      }
    }
  };

  if (!newRecipients.length) {
    data.abortReason =  "Finishing process. No new recipients found for original destinations: " + data.originalRecipients.join(", ");
    return Promise.resolve(data);
  }

  data.recipients = newRecipients;

  return Promise.resolve(data);
};

/**
 * Fetches the message data from S3.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.fetchMessage = function(data) {
  if (data.abortReason) return Promise.resolve(data);
  /*
  if (!isHostedOnAWS)
  {
    var emailRaw = fs.readFileSync("test/assets/2jre6qq031tv2e78hdmsc11h4j2orui1n4mbv081");
  }
  */
  // Copying email object to ensure read permission
  data.log({
    level: "info",
    message: "Fetching email at s3://" + data.config.emailBucket + '/' +
      data.config.inboundEmailKeyPrefix + data.email.messageId
  });
  return new Promise(function(resolve, reject) {
    data.s3.copyObject({
      Bucket: data.config.emailBucket,
      CopySource: data.config.emailBucket + '/' + data.config.inboundEmailKeyPrefix +
        data.email.messageId,
      Key: data.config.inboundEmailKeyPrefix + data.email.messageId,
      ACL: 'private',
      ContentType: 'text/plain',
      StorageClass: 'STANDARD'
    }, function(err) {
      if (err) {
        data.log({
          level: "error",
          message: "copyObject() returned error:",
          error: err,
          stack: err.stack
        });
        return reject(
          new Error("Error: Could not make readable copy of email."));
      }

      // Load the raw email from S3
      data.s3.getObject({
        Bucket: data.config.emailBucket,
        Key: data.config.inboundEmailKeyPrefix + data.email.messageId
      }, function(err, result) {
        if (err) {
          data.log({
            level: "error",
            message: "getObject() returned error:",
            error: err,
            stack: err.stack
          });
          return reject(
            new Error("Error: Failed to load message body from S3."));
        }
        data.emailData = result.Body.toString();
        return resolve(data);
      });
    });
  });
};

/**
 * Processes the message data, making updates to recipients and other headers
 * before forwarding message.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.processMessage = function(data) {
  if (data.abortReason) return Promise.resolve(data);

  var match = data.emailData.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m);
  var header = match && match[1] ? match[1] : data.emailData;
  var body = match && match[2] ? match[2] : '';

  // Add "Reply-To:" with the "From" address if it doesn't already exists
  if (!/^reply-to:[\t ]?/mi.test(header)) {
    match = header.match(/^from:[\t ]?(.*(?:\r?\n\s+.*)*\r?\n)/mi);
    var from = match && match[1] ? match[1] : '';
    if (from) {
      header = header + 'Reply-To: ' + from;
      data.log({
        level: "info",
        message: "Added Reply-To address of: " + from
      });
    } else {
      data.log({
        level: "info",
        message: "Reply-To address not added because From address was not " +
          "properly extracted."
      });
    }
  }

  // SES does not allow sending messages from an unverified address,
  // so replace the message's "From:" header with our own From address
  // (which is a verified domain)
  header = header.replace(
    /^from:[\t ]?(.*(?:\r?\n\s+.*)*)/mgi,
    function(match, from) {
      var fromText;
      data.fromAddress = from;
      if (data.config.fromEmail) {
        fromText = 'From: ' + from.replace(/<(.*)>/, '').trim() +
        ' <' + data.config.fromEmail + '>';
      } else {
        fromText = 'From: ' + from.replace('<', 'at ').replace('>', '') +
        ' <' + data.originalRecipient + '>';
      }
      return fromText;
    });

  // Add a prefix to the Subject
  if (data.config.subjectPrefix) {
    header = header.replace(
      /^subject:[\t ]?(.*)/mgi,
      function(match, subject) {

        if (process.env.DETECT_LOOP && subject.includes(data.config.subjectPrefix)) {

          // this will be picked up later
          data.abortReason = `Processing aborted: possible email loop detected - incoming email Subject already contains '${data.config.subjectPrefix}'`;
          return;
        }

        if (data.config.abortSubject && subject.match(data.config.abortSubject)) {
            data.abortReason = 'Processing aborted due to email subject';
            return;
        }

        var subj = data.config.subjectPrefix + subject;
        
        var msg = `Subject set to '${subj}'`;

        console.log(msg);

        return 'Subject: ' + subj;
      });
  }

  // Replace original 'To' header with a manually defined one
  if (data.billHeroToAddress) {
    header = header.replace(/^to:[\t ]?(.*)/mgi, () => 'To: ' + data.billHeroToAddress);
  }

  if (process.env.BILLHERO_BCC) {
    var replaced;

    header = header.replace(/^bcc:[\t ]?(.*)/mgi, () => {
      replaced = true;
      return 'Bcc: ' + process.env.BILLHERO_BCC;
    });

    // if there was no BCC in the first place then append one to the header
    if (!replaced) {
      var endsWithNewline = header.endsWith('\n');

      header += `${endsWithNewline ? '' : '\n'}Bcc: ${process.env.BILLHERO_BCC}${endsWithNewline ? '\n' : ''}`;

      data.extraInfo = data.extraInfo || [];

      // add a note
      data.extraInfo.push(`Added 'Bcc: ${process.env.BILLHERO_BCC}'`);
    }
  }

  // Remove the Return-Path header.
  header = header.replace(/^return-path:[\t ]?(.*)\r?\n/mgi, '');

  // Remove Sender header.
  header = header.replace(/^sender:[\t ]?(.*)\r?\n/mgi, '');

  // Remove Message-ID header.
  header = header.replace(/^message-id:[\t ]?(.*)\r?\n/mgi, '');

  // Remove all DKIM-Signature headers to prevent triggering an
  // "InvalidParameterValue: Duplicate header 'DKIM-Signature'" error.
  // These signatures will likely be invalid anyways, since the From
  // header was modified.
  header = header.replace(/^dkim-signature:[\t ]?.*\r?\n(\s+.*\r?\n)*/mgi, '');

  // deal with duplicate Mime-Version: headers
  var first = true;

  header = header.replace(/^mime-version:[\t ]?(.*)\r?\n/mgi, (match) => {

    // we keep the first instance, and get rid of any subsequent ones
    if (first) {
      first = false;
      return match;
    }

    console.log("Removed duplicate 'MIME-Version:' from header");

    return '';
  })

  data.emailData = header + body;
  return Promise.resolve(data);
};

/**
 * Send email using the SES sendRawEmail command.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.sendMessage = async (data) => {
  if (data.abortReason) return Promise.resolve(data);

/*
  if (data.abortReason) {
    var msg = `Processing of message <s3://${data.config.emailBucket}/${data.config.inboundEmailKeyPrefix}${data.email.messageId}|${data.email.messageId}> aborted: ${data.abortReason}`;
    console.log(msg);
    await this.sendMessage(msg);
    return resolve(data); // we don't want the lambda to retry
  }
*/
  var params = {
    // We don't send Destinations because we've manually set our To and Bcc addresses
    // Destinations: data.recipients,
    Source: data.originalRecipient,
    RawMessage: {
      Data: data.emailData
    }
  };

  var originalRecipients = data.originalRecipients.join(", ");

  data.log({
    level: "info",
    message: "sendMessage: Sending email via SES. Original recipients: " +
      originalRecipients + ". Transformed recipients: " +
      data.recipients.join(", ") + "."
  });

  // obfuscate the transformed email addresses
  var newRecipients = data.recipients.map(email => 
    email.replace(/(?<=[\w]{1})[\w-\._\+%]*(?=[\w]{1}@)/, (s) => 
      '*'.repeat(s.length)
    )
  ).join(', ');

  var slackMessage = `Forwarding email from: ${data.fromAddress || '<not extracted>'}\nOriginal recipients: ${originalRecipients}\nNew recipients: ${newRecipients}`;

  if (data.extraInfo) {
    slackMessage += `\n${data.extraInfo.join(', ')}`;
  }

  slackMessage += `\nOriginal message: <s3://${data.config.emailBucket}/${data.config.inboundEmailKeyPrefix}${data.email.messageId}|${data.email.messageId}>`;

  await Slack.sendMessage(slackMessage);

  return new Promise(function (resolve, reject) {
    data.ses.sendRawEmail(params, function (err, result) {
      if (err) {
        data.log({
          level: "error",
          message: "sendRawEmail() returned error.",
          error: err,
          stack: err.stack
        });
        return reject(new Error('Error: Email sending failed.'));
      }
      data.log({
        level: "info",
        message: "sendRawEmail() successful.",
        result: result
      });

      // return copyToOutbound(data);

      // Save the raw email to S3
      data.s3.putObject({
        Bucket: data.config.emailBucket,
        Body:  data.emailData,
        Key: data.config.outboundEmailKeyPrefix + data.email.messageId + '.txt' // to make life easier
      }, function(err, result) {
        if (err) {
          data.log({
            level: "error",
            message: "putObject() returned error:",
            error: err,
            stack: err.stack
          });
          return reject(
            new Error("Error: Failed to save outbound message body to S3."));
        }

        data.log({
          level: "info",
          message: `Original message written to ${data.config.outboundEmailKeyPrefix}`,
          result: result
        });
        
/*
        // delete the original item
        data.s3.deleteObject({
          Bucket: data.config.emailBucket,
          Key: data.config.inboundEmailKeyPrefix + data.email.messageId
        }, function(err, result) {
          if (err) {
            data.log({
              level: "error",
              message: "deleteObject() returned error:",
              error: err,
              stack: err.stack
            });
            return reject(
              new Error("Error: Failed to delete original message from S3."));
          }

          data.log({
            level: "info",
            message: `Original message removed from ${data.config.inboundEmailKeyPrefix}`,
            result: result
          });

        }); // deleteObject

*/        
      resolve(data);
      }); // putObject
    }); // sendRawEmail
  });
};

/**
 * Handler function to be invoked by AWS Lambda with an inbound SES email as
 * the event.
 *
 * @param {object} event - Lambda event from inbound email received by AWS SES.
 * @param {object} context - Lambda context object.
 * @param {object} callback - Lambda callback object.
 * @param {object} overrides - Overrides for the default data, including the
 * configuration, SES object, and S3 object.
 */
exports.handler = function(event, context, callback, overrides) {
  var steps = overrides && overrides.steps ? overrides.steps :
    [
      exports.parseEvent,
      exports.transformRecipients,
      exports.fetchMessage,
      exports.processMessage,
      exports.sendMessage
    ];
  var data = {
    event: event,
    callback: callback,
    context: context,
    config: overrides && overrides.config ? overrides.config : defaultConfig,
    log: overrides && overrides.log ? overrides.log : console.log,
    ses: overrides && overrides.ses ? overrides.ses : new AWS.SES(),
    s3: overrides && overrides.s3 ?
      overrides.s3 : new AWS.S3({signatureVersion: 'v4'})
  };

  if (process.env.LAMBDA_FLAGS_LOG_EMAIL == 'true') {
    console.log(data.event.Records[0].ses.receipt.recipients);
    console.log(data.event.Records[0].ses.mail);
  }

  Promise.series(steps, data)
    .then(function(data) {
      data.log({
        level: "info",
        message: data.abortReason || "Process finished successfully."
      });
      return data.callback();
    })
    .catch(function(err) {
      var msg = "Step returned error: " + err.message;
      data.log({
        level: "error",
        message: msg,
        error: err,
        stack: err.stack
      });
      return data.callback(new Error(msg));
    });
};

Promise.series = function(promises, initValue) {
  return promises.reduce(function(chain, promise) {
    if (typeof promise !== 'function') {
      return Promise.reject(new Error("Error: Invalid promise item: " +
        promise));
    }
    return chain.then(promise);
  }, Promise.resolve(initValue));
};

var copyToOutbound = function(data, moveFile = false) {
  // Save the raw email to S3
  data.s3.putObject({
    Bucket: data.config.emailBucket,
    Body:  data.emailData,
    Key: data.config.outboundEmailKeyPrefix + data.email.messageId + '.txt' // to make life easier
  }, function(err, result) {
    if (err) {
      data.log({
        level: "error",
        message: "Error: Failed to save outbound message body to S3.",
        error: err,
        stack: err.stack
      });
      
      return resolve(data);
      
      // return reject(new Error("Error: Failed to delete original message from S3."));
    }

    data.log({
      level: "info",
      message: `Original message written to ${data.config.outboundEmailKeyPrefix}`,
      result: result
    });
    
    if (moveFile) {
      // delete the original item
      data.s3.deleteObject({
        Bucket: data.config.emailBucket,
        Key: data.config.inboundEmailKeyPrefix + data.email.messageId
      }, function(err, result) {
        if (err) {
          data.log({
            level: "error",
            message: "Error: Failed to delete original message from S3.",
            error: err,
            stack: err.stack
          });
          return resolve(data);
          
          // return reject(new Error("Error: Failed to delete original message from S3."));
        }

        data.log({
          level: "info",
          message: `Original message removed from ${data.config.inboundEmailKeyPrefix}`,
          result: result
        });
      }); // deleteObject
    }
    return resolve(data);
  })
}


/********************************/
/********************************/
/********************************/
/********************************/
/********************************/
/********************************/
/********************************/
/********************************/
/********************************/
/********************************/
/********************************/
/********************************/
/********************************/
/********************************/

  // gary's sandbox
if (!isHostedOnAWS) {

  /*
  airTable.lookupUser('recxif5eaxTDpt6hcw').then(blah =>
    {
      console.log(blah);
    })
    */
  /*
  var v1 = !!JSON.parse((process.env.LAMBDA_FLAGS_LOG_EVENT || 'false').toLowerCase())
  var v2 = !!JSON.parse(process.env.LAMBDA_FLAGS_LOG_EVENT2)
  var v3 = !!JSON.parse(process.env.LAMBDA_FLAGS_LOG_EVENT3 || 'false')
*/

/*
  if (process.env.LAMBDA_FLAGS && process.env.LAMBDA_FLAGS.logEvent === true) {
    console.log(`event = ${event}`);
  }
*/
  // var v3 = !!JSON.parse(process.env.LAMBDA_FLAGS_LOG_EVENT3)

/*
  var callback = function(obj) {
    console.log(obj);
  };

  console.log(exports);
*/

/*
  exports.handler(
    event, 
    {}, // lambda context
    callback, // lanbda callback
    null // overrrides
    );
*/
  /*
  var msg = `Processing of email <s3://${'bucket'}/${'prefix'}${'blah'}|${'bleh'}> aborted: ${'oops'}`;
    console.log(msg);
    (async () => await this.sendMessage(msg));
  
  /*
  var header = 'name: value\nTo: gary@test.com\nSubject: blah\nBcc: bcc@bcc.com';

  header = 'name: value\nTo: gary@test.com\nSubject: blah\n';

  if (process.env.BILLHERO_BCC) {
    var replaced;

    header = header.replace(/^bcc:[\t ]?(.*)/mgi, () => {
      replaced = true;
      return 'Bcc: ' + process.env.BILLHERO_BCC;
    });

    if (!replaced) {
      var endsWithNewline = header.endsWith('\n');

      header += `${endsWithNewline ? '' : '\n'}Bcc: ${process.env.BILLHERO_BCC}${endsWithNewline ? '\n' : ''}`

      var data = {};
      data.extraInfo = data.extraInfo || [];
      data.extraInfo.push(`Added 'Bcc: ${process.env.BILLHERO_BCC}'`);
    }
  }
  */
  // test obfuscation
  /*
  var emails = ['gazzamate@hotmail.com', 'blahblah@blahblah.com'];

  emails = emails.map(email => 
    // obfuscate the transformed email addresses
    email.replace(/(?<=[\w]{1})[\w-\._\+%]*(?=[\w]{1}@)/, (s) => 
      '*'.repeat(s.length)
    )
  ).join(', ');
  */

  // var event = JSON.parse(require("fs").readFileSync("test/assets/event.json"));
  // exports.processMessage(event);
  // exports.handler(event, {}, callback, null);

  var r1 = "subscriber+hello@gmail.com".replace(/subscriber(\+|%2b)/mgi, '');
  var r2 = "subscriber%2bhello@gmail.com".replace(/subscriber(\+|%2b)/mgi, '');
  
  var fs = require("fs");

  var subject = 'hello Delivery Status Notification (Failure) world';
  var r = subject.match(defaultConfig.abortSubject);
  subject = 'Delivery Status Notification (Failure)';
  r = subject.match(defaultConfig.abortSubject);

  if (defaultConfig.abortSubject && subject.match(defaultConfig.abortSubject)) {
    console.log('Processing aborted due to email subject');
    return;
}

var raw = fs.readFileSync("example/u3tfss2q42tevbb0dkhar0joeqbtst54na21ea81").toString();
  var parsed = fs.readFileSync("example/u3tfss2q42tevbb0dkhar0joeqbtst54na21ea81.txt").toString();

  var n;
  var v = 'hello' + (n || '');
  var data = { 
    emailData: raw, 
    log: console.log,
    config: defaultConfig
  };
  console.dir(data);
  console.log(data);
  data.recipients = data.event.Records[0].ses.receipt.recipients
  // exports.processMessage(data).then((blah) => console.log(blah) )
  exports.transformRecipients(data).then((blah) => console.log(blah) )



} // isHostedOnAWS
