import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import {
  assertNoCredentials,
  seedUserSettings,
} from '@server/test/userSettings';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import userRoutes, { validateBulkParentalControlFields } from '.';

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

describe('GET /user/:id/watchlist', () => {
  it('omits notification settings from every requestedBy in the page', async () => {
    const owner = await seedUserSettings('demo@seerr.dev');

    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12345,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    await getRepository(Watchlist).save(
      new Watchlist({
        mediaType: MediaType.MOVIE,
        tmdbId: 12345,
        title: 'Watchlisted Movie',
        ratingKey: 'rk-12345',
        requestedBy: owner,
        media,
      })
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.get(`/user/${owner.id}/watchlist`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results.length, 1);
    assert.ok(!('settings' in res.body.results[0].requestedBy));
    assertNoCredentials(res.body);
  });
});

describe('GET /user/:id', () => {
  it('still returns full settings to the user themselves', async () => {
    const owner = await seedUserSettings('demo@seerr.dev');

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.get(`/user/${owner.id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.settings.pgpKey, 'test-pgp-key');
    assert.strictEqual(
      res.body.settings.pushoverUserKey,
      'test-pushover-user-key'
    );
  });

  it('still returns full settings to a manage-users admin', async () => {
    const owner = await seedUserSettings('demo@seerr.dev');

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.get(`/user/${owner.id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.settings.pgpKey, 'test-pgp-key');
  });

  it('strips settings for an unrelated user', async () => {
    const admin = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    await seedUserSettings('admin@seerr.dev');

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.get(`/user/${admin.id}`);

    assert.strictEqual(res.status, 200);
    assert.ok(!('settings' in res.body));
    assertNoCredentials(res.body);
  });
});

describe('validateBulkParentalControlFields', () => {
  it('accepts an empty body', () => {
    assert.equal(validateBulkParentalControlFields({}), null);
  });

  it('accepts valid movie and TV ratings with blockUnrated', () => {
    assert.equal(
      validateBulkParentalControlFields({
        maxMovieRating: 'PG-13',
        maxTvRating: 'TV-14',
        blockUnrated: true,
      }),
      null
    );
  });

  it('rejects an invalid movie rating', () => {
    assert.match(
      validateBulkParentalControlFields({ maxMovieRating: 'XX' }) ?? '',
      /Invalid movie rating: XX/
    );
  });

  it('rejects an invalid TV rating', () => {
    assert.match(
      validateBulkParentalControlFields({ maxTvRating: 'XX' }) ?? '',
      /Invalid TV rating: XX/
    );
  });

  it('rejects a non-boolean blockUnrated', () => {
    assert.match(
      validateBulkParentalControlFields({
        blockUnrated: 'yes' as unknown as boolean,
      }) ?? '',
      /blockUnrated must be a boolean/
    );
  });

  it('allows an empty-string rating to clear the restriction', () => {
    assert.equal(
      validateBulkParentalControlFields({
        maxMovieRating: '',
        maxTvRating: '',
      }),
      null
    );
  });
});

async function createAdmin(email: string): Promise<User> {
  const user = new User({
    email,
    username: email.split('@')[0],
    userType: UserType.LOCAL,
    permissions: Permission.ADMIN,
    avatar: '',
  });
  await user.setPassword('test1234');
  return getRepository(User).save(user);
}

async function limitsOf(id: number) {
  const user = await getRepository(User).findOneOrFail({
    where: { id },
    relations: { settings: true },
  });
  return {
    permissions: user.permissions,
    maxMovieRating: user.settings?.maxMovieRating ?? null,
  };
}

describe('POST /user/:id/settings/parental-controls', () => {
  it('lets the owner limit their own account', async () => {
    const owner = await loginAs('admin@seerr.dev', 'test1234');
    const res = await owner
      .post('/user/1/settings/parental-controls')
      .send({ maxMovieRating: 'PG-13', maxTvRating: 'TV-14' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await limitsOf(1)).maxMovieRating, 'PG-13');
  });

  it('lets an admin limit themselves but not the owner or other admins', async () => {
    const admin = await createAdmin('second-admin@seerr.dev');
    const third = await createAdmin('third-admin@seerr.dev');
    const agent = await loginAs('second-admin@seerr.dev', 'test1234');
    const body = { maxMovieRating: 'PG' };

    const self = await agent
      .post(`/user/${admin.id}/settings/parental-controls`)
      .send(body);
    const owner = await agent
      .post('/user/1/settings/parental-controls')
      .send(body);
    const other = await agent
      .post(`/user/${third.id}/settings/parental-controls`)
      .send(body);

    assert.strictEqual(self.status, 200);
    assert.strictEqual(owner.status, 403);
    assert.strictEqual(other.status, 403);
    assert.strictEqual((await limitsOf(admin.id)).maxMovieRating, 'PG');
    assert.strictEqual((await limitsOf(1)).maxMovieRating, null);
    assert.strictEqual((await limitsOf(third.id)).maxMovieRating, null);
  });

  it('does not let a regular user change their own limits', async () => {
    const demo = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent
      .post(`/user/${demo.id}/settings/parental-controls`)
      .send({ maxMovieRating: 'NC-17' });

    assert.strictEqual(res.status, 403);
  });
});

describe('PUT /user (bulk edit) parental controls', () => {
  it('lets the owner limit admins without touching their permissions', async () => {
    const otherAdmin = await createAdmin('other-admin@seerr.dev');
    const demo = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const owner = await loginAs('admin@seerr.dev', 'test1234');
    const res = await owner
      .put('/user')
      .send({ ids: [otherAdmin.id, demo.id], maxMovieRating: 'PG' });
    assert.strictEqual(res.status, 200);

    assert.deepEqual(await limitsOf(otherAdmin.id), {
      permissions: Permission.ADMIN,
      maxMovieRating: 'PG',
    });
    assert.deepEqual(await limitsOf(demo.id), {
      permissions: 32,
      maxMovieRating: 'PG',
    });
  });

  it('skips other admins when a non-owner admin bulk edits', async () => {
    await createAdmin('second-admin@seerr.dev');
    const third = await createAdmin('third-admin@seerr.dev');
    const demo = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const agent = await loginAs('second-admin@seerr.dev', 'test1234');
    const res = await agent
      .put('/user')
      .send({ ids: [third.id, demo.id], maxMovieRating: 'PG' });
    assert.strictEqual(res.status, 200);

    assert.strictEqual((await limitsOf(third.id)).maxMovieRating, null);
    assert.strictEqual((await limitsOf(demo.id)).maxMovieRating, 'PG');
  });
});
