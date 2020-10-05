const Airtable = require('airtable');
const Slack = require('./Slack');

const AirtableBase = new Airtable({apiKey: process.env.AIRTABLE_API_KEY}).base(process.env.AIRTABLE_BASE_ID);

module.exports = {
    lookupUser: async (bhid) => {
        return AirtableBase(process.env.AIRTABLE_USERS_TABLE).find(bhid)
            .then((record) => {
                console.log(`AirTable lookup for ${bhid} found ${record.fields['Email']}`);
                return record.fields['Email'];
            })
            .catch(async (err) => {
                var msg = `AirTable lookup for bhid ${bhid} failed: ${err}`;
                console.log(msg);
                await Slack.sendMessage(msg, ':mag:');
                return;
            });
    }
};