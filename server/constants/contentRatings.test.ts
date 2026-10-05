import {
  canEditParentalControls,
  getAllowedRatings,
  MOVIE_RATINGS,
  shouldFilterMovie,
  shouldFilterTv,
  TV_RATINGS,
} from '@server/constants/contentRatings';
import { Permission } from '@server/lib/permissions';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('shouldFilterMovie', () => {
  it('allows a rating within the cap', () => {
    assert.equal(shouldFilterMovie('PG', 'PG-13'), false);
  });

  it('blocks a rating above the cap', () => {
    assert.equal(shouldFilterMovie('R', 'PG-13'), true);
  });

  it('allows unrated content when blockUnrated is false', () => {
    assert.equal(shouldFilterMovie('NR', 'PG-13', false), false);
  });

  it('blocks unrated content when blockUnrated is true', () => {
    assert.equal(shouldFilterMovie('NR', 'PG-13', true), true);
    assert.equal(shouldFilterMovie(undefined, 'PG-13', true), true);
  });

  it('fails closed on an invalid maxRating', () => {
    assert.equal(shouldFilterMovie('G', 'NOT-A-RATING', false), true);
  });
});

describe('shouldFilterTv', () => {
  it('allows a rating within the cap', () => {
    assert.equal(shouldFilterTv('TV-PG', 'TV-14'), false);
  });

  it('blocks a rating above the cap', () => {
    assert.equal(shouldFilterTv('TV-MA', 'TV-14'), true);
  });

  it('allows unrated content when blockUnrated is false', () => {
    assert.equal(shouldFilterTv('Unrated', 'TV-14', false), false);
  });

  it('blocks unrated content when blockUnrated is true', () => {
    assert.equal(shouldFilterTv('Unrated', 'TV-14', true), true);
    assert.equal(shouldFilterTv(null, 'TV-14', true), true);
  });

  it('fails closed on an invalid maxRating', () => {
    assert.equal(shouldFilterTv('TV-G', 'NOT-A-RATING', false), true);
  });
});

describe('getAllowedRatings', () => {
  it('returns ratings up to the cap for movies', () => {
    assert.deepEqual(getAllowedRatings('movie', { maxMovieRating: 'PG' }), [
      'G',
      'PG',
    ]);
  });

  it('returns ratings up to the cap for tv', () => {
    assert.deepEqual(getAllowedRatings('tv', { maxTvRating: 'TV-14' }), [
      'TV-Y',
      'TV-Y7',
      'TV-G',
      'TV-PG',
      'TV-14',
    ]);
  });

  it('returns the full ratings list when there is no cap but unrated is blocked', () => {
    assert.deepEqual(getAllowedRatings('movie', { blockUnrated: true }), [
      ...MOVIE_RATINGS,
    ]);
    assert.deepEqual(getAllowedRatings('tv', { blockUnrated: true }), [
      ...TV_RATINGS,
    ]);
  });

  it('returns undefined when there is no cap and unrated is allowed', () => {
    assert.equal(getAllowedRatings('movie', {}), undefined);
    assert.equal(getAllowedRatings('tv', {}), undefined);
  });

  it('fails closed to the most restrictive rating on an invalid cap', () => {
    assert.deepEqual(
      getAllowedRatings('movie', { maxMovieRating: 'NOT-A-RATING' }),
      [MOVIE_RATINGS[0]]
    );
    assert.deepEqual(getAllowedRatings('tv', { maxTvRating: 'NOT-A-RATING' }), [
      TV_RATINGS[0],
    ]);
  });
});

describe('canEditParentalControls', () => {
  const owner = { id: 1, permissions: Permission.ADMIN };
  const admin = { id: 2, permissions: Permission.ADMIN };
  const otherAdmin = { id: 3, permissions: Permission.ADMIN };
  const manager = { id: 4, permissions: Permission.MANAGE_USERS };
  const user = { id: 5, permissions: Permission.REQUEST };

  it('lets the owner limit anyone, including themselves', () => {
    assert.equal(canEditParentalControls(owner, owner), true);
    assert.equal(canEditParentalControls(owner, admin), true);
    assert.equal(canEditParentalControls(owner, user), true);
  });

  it('lets admins and user managers limit themselves', () => {
    assert.equal(canEditParentalControls(admin, admin), true);
    assert.equal(canEditParentalControls(manager, manager), true);
  });

  it('keeps the owner and other admins out of reach of non-owners', () => {
    assert.equal(canEditParentalControls(admin, owner), false);
    assert.equal(canEditParentalControls(admin, otherAdmin), false);
    assert.equal(canEditParentalControls(manager, admin), false);
    assert.equal(
      canEditParentalControls(manager, { ...owner, permissions: 0 }),
      false
    );
  });

  it('lets user managers limit regular users and other managers', () => {
    assert.equal(canEditParentalControls(admin, user), true);
    assert.equal(canEditParentalControls(manager, user), true);
    assert.equal(canEditParentalControls(admin, manager), true);
  });

  it('never lets users without Manage Users edit limits, even their own', () => {
    assert.equal(canEditParentalControls(user, user), false);
    assert.equal(canEditParentalControls(undefined, user), false);
  });
});
