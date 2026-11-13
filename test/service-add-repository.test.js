'use strict';
// The repository a service id names (A7, plan 2026-11-13 Y.1): the git service's repository is
// OpenVibers/OpenVibe-Git, with a hyphen. OpenVibe.Git is the site's name, and a clone URL built from it
// would look for a repository that does not exist.
const assert = require('node:assert/strict');
const { repositorySlug } = require('../lib/commands/service-add');
const { test, runTests } = require('./helpers');

runTests([
    test('a service id names its GitHub repository, and the git service keeps its hyphen', () => {
        assert.equal(repositorySlug('network'), 'OpenVibe.Network');
        assert.equal(repositorySlug('mediahub'), 'OpenVibe.Mediahub');
        assert.equal(repositorySlug('git'), 'OpenVibe-Git');
    }),
]);
