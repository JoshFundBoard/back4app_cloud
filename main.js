const MINPLACE = 1000;

function errorStr(str, err) {
  return `${str} - ${err.code ? err.code : ''} ${err.message ? err.message : ''}`;
}

async function getOrCreateOwnObject(className, currentUser) {
  const Obj = Parse.Object.extend(className);
  const query = new Parse.Query(Obj);
  query.equalTo('user', currentUser);

  let obj = await query.first({ useMasterKey: true });

  if(!obj || Object.keys(obj).length === 0)  {
    obj = new Obj();
    obj.set('user', currentUser);
  }

  return obj;
}

// get more than 1000 results from http://blog.benoitvallon.com/tips/the-parse-1000-objects-limit/
function simpleQuery(query, batchNumber) {
  query.limit(1000);
  if (batchNumber) query.skip(batchNumber * 1000);

  return query.find().then(
    function(objects) {
      return objects;
    },
    function(error) {
      return error;
    }
  );
}

function recursiveQuery(query, batchNumber = 0, allObjects) {
  return simpleQuery(query, batchNumber).then(function(objects) {
    // concat the intermediate objects into the final array
    allObjects = allObjects.concat(objects);
    // if the objects length is 1000, it means that we are not at the end of the list
    if (objects.length === 1000) {
      batchNumber +=1;
      return recursiveQuery(query, batchNumber, allObjects);
    } else {
      return allObjects;
    }
  });
}

Parse.Cloud.define('initUser', async(request) => {
  let currentUser = request.user;
  const Registration = Parse.Object.extend('Registration');

  try {
    const rQuery = new Parse.Query(Registration);
    rQuery.equalTo('user', currentUser);
    let rUser = await rQuery.first({ useMasterKey: true });

    if (!rUser || Object.keys(rUser).length === 0) {
      currentUser.setACL(new Parse.ACL(currentUser));
      try {
        await currentUser.save(null, { useMasterKey: true });
      } catch (error) {
        throw new Error(errorStr('setACL error', error));
      }

      rUser = new Registration();

      const cQuery = new Parse.Query(Registration);
      try {
        await cQuery.count({ useMasterKey: true }).then(c => {
          rUser.set('place', c);
          rUser.set('user', currentUser);
          rUser.set('email', currentUser.email);

          try {
            return rUser.save(null, { useMasterKey: true });
          } catch (error) {
            throw new Error(errorStr('Registration save error', error));
          }

        });
      } catch (error) {
        throw new Error(errorStr('Registration count error', error));
      }
    }
    return rUser;

  } catch (error) {
    throw new Error(errorStr('Init error', error));
  }
});

async function checkWaitlist(user) {
  // check waitlist
  const Registration = Parse.Object.extend('Registration');
  const rQuery = new Parse.Query(Registration);
  rQuery.equalTo('user', user);
  const rUser = await rQuery.first({ useMasterKey: true });
  if (!rUser) throw new Error('Registration not found.');
  const userJSON = rUser.toJSON();
  const place = userJSON.place;
  if (typeof place !== 'number') throw new Error('Place on waitlist not found.');
  if (place > MINPLACE) throw new Error(`This account is number ${place} on the waitlist.`);
  return place < MINPLACE || userJSON.overridePlace;
}

Parse.Cloud.define('updateProfile', async(request) => {
  const params = request.params;
  const currentUser = request.user;
  const profile = await getOrCreateOwnObject('Profile', currentUser);

  profile.set(params);

  try {
    await checkWaitlist(currentUser);
    await profile.save(null, { useMasterKey: true});
    return profile;
  } catch (error){
    throw new Error(errorStr('updateProfile error', error));
  }
});

Parse.Cloud.define('getOwnProfile', async(request) => {
  const currentUser = request.user;

  const Profile = Parse.Object.extend('Profile');
  const query = new Parse.Query(Profile);
  query.equalTo('user', currentUser);

  try {
    await checkWaitlist(currentUser);
    const profile = await query.first({ useMasterKey: true });
    return profile;
  } catch (error){
    throw new Error(errorStr('getOwnProfile error', error));
  }
});

Parse.Cloud.define('getPublicProfile', async(request) => {
  const params = request.params;
  const uuid = params.uuid;
  const Profile = Parse.Object.extend('Profile');
  const query = new Parse.Query(Profile);
  query.equalTo('uuid', uuid);
  query.select(
    'name',
    'primary_job_title',
    'primary_organization_name',
    'primary_organization_homepage',
    'primary_organization_logo',
    'description',
    'linkedin',
    'twitter',
    'permalink',
    'links',
    'raise',
    'remote',
    'location_city',
    'location_state',
    'team_size'
  );

  try {
    const profile = await query.first({ useMasterKey: true });
    return profile;
  } catch (error){
    throw new Error(errorStr('getPublicProfile error', error));
  }
});

Parse.Cloud.define('getPublicUser', async(request) => {
  const params = request.params;
  const uuid = params.uuid;
  const User = Parse.Object.extend('User');
  const query = new Parse.Query(User);
  query.equalTo('uuid', uuid);
  query.select('board_public'); // this doesn't seem to work

  try {
    const user = await query.first({ useMasterKey: true });
    const { board_public } = user && user.toJSON ? user.toJSON() : {};
    return { board_public };
  } catch (error){
    throw new Error(errorStr('getPublicUser error', error));
  }
});

Parse.Cloud.define('getOwnInvestors', async(request) => {
  const currentUser = request.user;

  const Investor = Parse.Object.extend('Investor');
  const query = new Parse.Query(Investor);
  query.equalTo('user', currentUser);
  query.exclude('user'); // For some reason this works, but only for one string.

  try {
    await checkWaitlist(currentUser);
    const investors = await query.find({ useMasterKey: true });
    return investors;
  } catch (error){
    throw new Error(errorStr('getOwnInvestors error', error));
  }
});

async function safeAddInvestor(params, currentUser) {
  const Investor = Parse.Object.extend('Investor');
  const query = new Parse.Query(Investor);
  query.equalTo('user', currentUser);
  query.equalTo('uuid', params.uuid);

  let investor = await query.first({ useMasterKey: true });

  // Only add the investor if they don't exist yet.
  if(!investor || Object.keys(investor).length === 0)  {
    investor = new Investor();
    investor.set(params);
    investor.set('user', currentUser);
    try {
      await investor.save(null, { useMasterKey: true});
      return investor;
    } catch (error){
      throw new Error(errorStr('SafeAddInvestor error', error));
    }
  }
}

Parse.Cloud.define('bulkAddInvestors',async(request) => {
  const currentUser = request.user;
  const params = request.params;
  const investors = params.investors;
  try {
    await checkWaitlist(currentUser);
    const addInvestors = investors.map(async i => {
      return await safeAddInvestor(i, currentUser);
    });
    const completeInvestors = await Promise.all(addInvestors);
    return completeInvestors;
  } catch (error){
    throw new Error(errorStr('BulkAddInvestor error', error));
  }
})

Parse.Cloud.define('updateInvestor', async(request) => {
  const params = request.params;
  const currentUser = request.user;
  const Investor = Parse.Object.extend('Investor');
  const query = new Parse.Query(Investor);

  let investor;

  if (params.objectId) {
    investor = await query.get(params.objectId, { useMasterKey: true });
  } else {
    query.equalTo('user', currentUser);
    query.equalTo('uuid', params.uuid);

    investor = await query.first({useMasterKey: true});

    /*
    if (!investor || Object.keys(investor).length === 0) {
      investor = new Investor();
    }
   */
  }

  try {
    investor.set(params);
    investor.set('user', currentUser);
    await checkWaitlist(currentUser);
    await investor.save(null, { useMasterKey: true});
    return investor;
  } catch (error){
    throw new Error(errorStr('updateInvestor error', error));
  }
});

Parse.Cloud.define('claimIntro', async(request) => {
  const params = request.params;
  const objectId = params.objectId;
  const Investor = Parse.Object.extend('Investor');
  const query = new Parse.Query(Investor);
  query.equalTo('objectId', objectId);

  const investor = await query.first({useMasterKey: true});
  investor.set('intros', params.intros);
  // investor.set('stage', 'connected');

  try {
    await investor.save(null, { useMasterKey: true});
    return investor;
  } catch (error){
    throw new Error(errorStr('claim intro error', error));
  }
});

Parse.Cloud.define('getPublicInvestors', async(request) => {
  const params = request.params;
  const profileUUID = params.uuid;

  const User = Parse.Object.extend('User');
  const uQuery = new Parse.Query(User);
  uQuery.equalTo('uuid', profileUUID);
  uQuery.equalTo('board_public', true);

  const Investor = Parse.Object.extend('Investor');
  const query = new Parse.Query(Investor);
  query.equalTo('profileUUID', profileUUID);
  query.equalTo('published', true);
  query.select([
    'uuid',
    'name',
    'stage',
    'intros',
    'primary_job_title',
    'primary_organization_name',
    'linkedin',
    'twitter',
    'permalink',
    'location_city',
    'location_state',
  ]);

  try {
    // TODO: is there a more efficient way to return [] if the user isn't found, by just calling investors?
    const user = await uQuery.first({useMasterKey: true});
    if (!user) return [];
    const investors = await query.find({ useMasterKey: true });
    return investors;
  } catch (error){
    throw new Error(errorStr('GetPublicInvestors error', error));
  }
});

Parse.Cloud.define('getFoundersByPermalink', async(request) => {
  const params = request.params;
  const { permalinks } = params;

  const Founders = Parse.Object.extend('FoundersCB');
  const query = new Parse.Query(Founders);
  query.containedIn('permalink', permalinks);

  try {
    const result = await query.find({useMasterKey: true});
    return result;
  } catch (error){
    throw new Error(errorStr('Get founders by permalink error', error));
  }
});

Parse.Cloud.define('getStartups', async(request) => {
  const params = request.params;
  const {
    permalinks,
    uuids,
    page,
    includeFounders,
  } = params;

  const StartupsObj = Parse.Object.extend('StartupsCB');
  const sQuery = new Parse.Query(StartupsObj);
  sQuery.limit(1000);
  if (page) sQuery.skip(1000 * page);

  const Founders = Parse.Object.extend('FoundersCB');
  const fQuery = new Parse.Query(Founders);

  try {
    if (Array.isArray(permalinks) && permalinks.length) {
      sQuery.containedIn('permalink', permalinks);
    } else if(Array.isArray(uuids) && uuids.length) {
      sQuery.containedIn('uuid', uuids);
    }
    // If no parameters are given, return all startups.

    const sResult = await sQuery.find({ useMasterKey: true });
    // const startupResults = [];
    // const sResult = await recursiveQuery(sQuery, 0, startupResults);
    const startupsArr = [];
    for (result of sResult) {
      const startupJSON = { ...result.attributes };
      if (startupJSON.founder_permalinks && includeFounders) {
        const fLinks = startupJSON.founder_permalinks.split(',');
        fQuery.containedIn('permalink', fLinks);
        await fQuery.find({useMasterKey: true}).then(fResults => {
          startupJSON.founders = fResults.map(f => ({...f.attributes}));
        })
      }
      startupsArr.push(startupJSON);
    }
    return startupsArr;
  } catch (error){
    throw new Error(errorStr('GetStartups error', error));
  }
});

Parse.Cloud.define('addOrUpdateStartup',async(request) => {
  const params = request.params;
  const { uuid, permalink } = params;

  const Startup = Parse.Object.extend('StartupsCB');
  const query = new Parse.Query(Startup);
  if (permalink) {
    query.equalTo('permalink', permalink);
  } else {
    query.equalTo('uuid', uuid);
  }

  let startup = await query.first({ useMasterKey: true });

  if(!startup || Object.keys(startup).length === 0) {
    startup = new Startup();
  }
  startup.set(params);
  try {
    await startup.save(null, { useMasterKey: true});
    return startup;
  } catch (error){
    throw new Error(errorStr('addOrUpdateStartup error', error));
  }
})

async function addOrUpdateFounder(params) {
  const Founder = Parse.Object.extend('FoundersCB');
  const query = new Parse.Query(Founder);
  query.equalTo('permalink', params.permalink);

  let founder = await query.first({ useMasterKey: true });

  // Only add the founder if they don't exist yet.
  if(!founder || Object.keys(founder).length === 0) {
    founder = new Founder();
  }
  founder.set(params);
  try {
    await founder.save(null, { useMasterKey: true});
    return founder;
  } catch (error){
    throw new Error(errorStr('addOrUpdateFounder error', error));
  }
}

Parse.Cloud.define('addOrUpdateFoundersByStartup',async(request) => {
  const params = request.params;
  const { founders = [], founded_org_uuid } = params;

  try {
    const addFounders = founders.map(async f => {
      const fData = {
        ...f,
        founded_org_uuid: founded_org_uuid || f.founded_org_uuid,
      }
      return await addOrUpdateFounder(fData);
    });
    const completedFounders = await Promise.all(addFounders);
    return completedFounders;
  } catch (error){
    throw new Error(errorStr('addOrUpdateFoundersByStartup error', error));
  }
})
