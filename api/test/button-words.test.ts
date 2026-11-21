// Typed answers to waiting buttons count as the tap (the owner's bug report: "yeah, add them" to
// [Add all 122] [Don't add these] got "Which product and price would you like to add?").
import { matchButton } from '../src/bots/button-words';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const add = [{ id: 'imp:all', title: 'Add all 122' }, { id: 'imp:cancel', title: "Don't add these" }];
const looks = [{ id: 'imp:all', title: 'Looks good' }, { id: 'imp:list', title: 'See full list' }];
const states = [{ id: 'is:yes', title: 'Yes, other states' }, { id: 'is:no', title: 'No, just nearby' }];
const del = [{ id: 'yes', title: 'Yes, delete it' }, { id: 'no', title: 'No, keep it' }];
const fee = [{ id: 'fee:customer', title: 'Customers pay' }, { id: 'fee:owner', title: "I'll pay" }];
const sunday = [{ id: 'hrv:closed', title: 'Closed' }, { id: 'hrv:same', title: 'Same as Mon–Fri' }, { id: 'hrv:diff', title: 'Different hours' }];

test('button words: yes-style replies are the confirm button, no-style replies the other', () => {
  for (const t of ['yeah, add them', 'ok', 'yes pls', 'looks good', 'Yes', 'oya', 'no wahala', 'sure']) assert.equal(matchButton(t, add), 'imp:all', t);
  for (const t of ['no', 'nah leave it', "don't", 'cancel', 'leave am']) assert.equal(matchButton(t, add), 'imp:cancel', t);
  assert.equal(matchButton('looks good', looks), 'imp:all', 'a button\'s own words');
  assert.equal(matchButton('yeah, add them', looks), 'imp:all');
  assert.equal(matchButton('see full list', looks), 'imp:list');
  assert.equal(matchButton('just lagos', states), 'is:no', 'a word only one button has');
  assert.equal(matchButton('no', states), 'is:no');
  assert.equal(matchButton('yes pls', del), 'yes');
  assert.equal(matchButton('nah leave it', del), 'no');
  assert.equal(matchButton('customers', fee), 'fee:customer');
  assert.equal(matchButton('closed', sunday), 'hrv:closed');
});

test('button words: unclear or longer messages are left alone', () => {
  assert.equal(matchButton('ok', sunday), null, 'three buttons and no "no" button: yes means nothing');
  assert.equal(matchButton('Jollof rice 2500', looks), null);
  assert.equal(matchButton('no, my shop is called Ada Thrift and I sell bags', fee), null);
  assert.equal(matchButton('ok', []), null);
});
