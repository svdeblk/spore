import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReserved, isSlur } from '../lib/names.js';

test('site, vocabulary and account words are reserved', () => {
  for (const name of ['user', 'users', 'me', 'admin', 'staff', 'official', 'api', 'settings', 'soil', 'substrate',
    'symbionts', 'mutuals', 'morels', 'puffballs', 'prune', 'groups', 'spore_bond', 'u_s_e_r', 'no_matter']) {
    assert.ok(isReserved(name), name);
  }
});

test('ordinary handles are not reserved', () => {
  for (const name of ['alice', 'user_friendly_bob', 'matter_of_fact', 'soil_scientist', 'meadow']) {
    assert.ok(!isReserved(name), name);
  }
});

test('slurs are caught, including swapped letters and whole parts of a name', () => {
  for (const name of ['nigger', 'n1gger', 'xx_n1gg4_xx', 'f4ggot', 'the_fag', 'fag123', 'fags', 'tr4nny', 'big_retard',
    'xx_spic_xx', 'dyke_life', 'wetback99', 'k1ke']) {
    assert.ok(isSlur(name), name);
  }
});

test('ordinary words that contain a short portion otherwise would be a slur are left alone. so is all swearing', () => {
  for (const name of ['spicy_ramen', 'raccoon', 'cocoon', 'homogenize', 'dagobah', 'peacock', 'wopper', 'scunthorpe',
    'fuck_yeah', 'shitposter', 'damn_it', 'bastard_son', 'alice']) {
    assert.ok(!isSlur(name), name);
  }
});
