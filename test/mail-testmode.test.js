// While something is being tried out, every message goes to one address and
// nobody else's. MAIL_TEST_TO holds them back.
//
// Done inside mailer.send rather than at each of the places that send, because
// there are a dozen of those and the one eventually missed would be the one
// that wrote to the whole office. This drives the real send and reads what
// would have gone over the wire.
'use strict';
const path = require('path');
const mailer = require(path.join(__dirname, '..', 'mailer.js'));

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

const realFetch = global.fetch;
let posted = null;
global.fetch = function (url, opts) {
  if (String(url).indexOf('api.resend.com') > -1) {
    posted = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'm1' }) });
  }
  return realFetch(url, opts);
};
process.env.RESEND_API_KEY = 'test-key';
process.env.RESEND_FROM = 'Attendance <a@b.test>';

const MSG = {
  to: ['karan@homeweavers.net', 'nitish@homeweavers.net'],
  cc: ['shivani@homeweavers.net'],
  subject: 'Casual leave · Keshav Garg',
  html: '<p>A request is waiting.</p>',
  attachments: [{ filename: 'x.csv', content: 'QQ==' }]
};

(async () => {
  /* Unset: the message goes where it says it goes. */
  delete process.env.MAIL_TEST_TO;
  posted = null;
  await mailer.send(MSG);
  check('with nothing set, a message goes to the people it names',
    JSON.stringify(posted.to) === JSON.stringify(MSG.to)
      && JSON.stringify(posted.cc) === JSON.stringify(MSG.cc), { to: posted.to, cc: posted.cc });
  check('and its subject is its own', posted.subject === MSG.subject, posted.subject);

  /* Set: nobody else is written to, whatever the message said. */
  process.env.MAIL_TEST_TO = 'support@homeweavers.net';
  posted = null;
  await mailer.send(MSG);
  check('held back, it goes to the one address and nobody else',
    JSON.stringify(posted.to) === JSON.stringify(['support@homeweavers.net']),
    posted.to);
  check('nobody is copied on it either', posted.cc === undefined, posted.cc);
  check('the subject says it is a test', /^\[test\] /.test(posted.subject), posted.subject);
  check('and the message says who it was addressed to',
    /Testing &mdash; held back|Testing — held back/.test(posted.html)
      && /karan@homeweavers\.net/.test(posted.html)
      && /nitish@homeweavers\.net/.test(posted.html)
      && /shivani@homeweavers\.net/.test(posted.html),
    posted.html.slice(0, 400));
  check('the message itself is the real one, not a stand-in',
    /A request is waiting/.test(posted.html), posted.html.slice(-200));
  check('and what it carries still goes with it',
    (posted.attachments || []).length === 1, posted.attachments);

  /* A single recipient, and an address written as a string rather than a list. */
  posted = null;
  await mailer.send({ to: 'keshav@homeweavers.net', subject: 'Your leave', html: '<p>Approved.</p>' });
  check('one recipient is held back the same way',
    JSON.stringify(posted.to) === JSON.stringify(['support@homeweavers.net'])
      && /keshav@homeweavers\.net/.test(posted.html), posted.to);

  /* Rubbish in the variable must not quietly send to everybody. */
  process.env.MAIL_TEST_TO = 'karan';
  posted = null;
  await mailer.send(MSG);
  check('a value that is not an address is ignored, not obeyed halfway',
    JSON.stringify(posted.to) === JSON.stringify(MSG.to), posted.to);

  delete process.env.MAIL_TEST_TO;
  global.fetch = realFetch;
  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
