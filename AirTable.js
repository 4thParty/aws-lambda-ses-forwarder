const Airtable = require('airtable');
const Slack = require('./Slack');

const AirtableBase = new Airtable({apiKey: process.env.AIRTABLE_API_KEY}).base(process.env.AIRTABLE_BASE_ID);

module.exports = {
    lookupUser: async (userName) => {
        var userNameLower = userName.toLowerCase();
        return AirtableBase(process.env.AIRTABLE_USERS_TABLE).select(
            { filterByFormula: `OR(SEARCH('${userNameLower}', LOWER({Forwarder match address})), LOWER(bhid)='${userNameLower}'))` }
        )
        .all()
        .then((recs) => {
            if (!recs || !recs.length) {
                var msg = `AirTable lookup for userName '${userName}' found 0 records`;
                console.log(msg);
                if (process.env.SLACK_CHANNEL) {
                    return Slack.sendMessage(msg, ':mag:')
                }
                return;
            }

            var email = recs[0].fields["Email"];
            console.log(`AirTable lookup for '${userName}' found ${email}`);
            
            return email;
        })
        .catch((err) => {
            var msg = `AirTable lookup for userName '${userName}' failed: ${err}`;
            console.log(msg);
            
            if (process.env.SLACK_CHANNEL) {
                return Slack.sendMessage(msg, ':mag:')
            }
            
            return;
        })
    }

};

