'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool, getConnection } = require('../config/mysql-pool');

const models = new Map();

class Schema {
  constructor(definition = {}, options = {}) {
    this.definition = definition;
    this.options = options;
    this.methods = {};
    this.hooks = { save: [] };
    this.transforms = {};
    this.indexDefinitions = [];
  }
  pre(event, handler) { if (event === 'save') this.hooks.save.push(handler); }
  set(key, value) { if (key === 'toJSON') this.transforms = value || {}; }
  index(fields, options = {}) { this.indexDefinitions.push({ fields, options }); }
}
Schema.Types = { ObjectId: 'ObjectId', Mixed: 'Mixed', Map: 'Map' };

function objectId() { return crypto.randomBytes(12).toString('hex'); }
function isObjectId(value) { return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value); }
function ObjectId(value) {
  this.value = value || objectId();
}
ObjectId.prototype.toString = function toString() { return String(this.value); };
ObjectId.prototype.valueOf = function valueOf() { return String(this.value); };
ObjectId.isValid = value => isObjectId(String(value));
function snake(value) {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}
function quote(value) { return `\`${String(value).replace(/`/g, '``')}\``; }
function pathGet(object, path) {
  const parts = String(path).split('.');
  const read = (value, index) => {
    if (value == null) return undefined;
    if (index >= parts.length) return value;
    if (Array.isArray(value)) return value.map(item => read(item, index)).flat().filter(item => item !== undefined);
    return read(value[parts[index]], index + 1);
  };
  return read(object, 0);
}
function pathSet(object, path, value) {
  const parts = String(path).split('.');
  let target = object;
  for (const key of parts.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[parts[parts.length - 1]] = value;
}
function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function fieldSpec(descriptor) {
  if (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor) && Object.prototype.hasOwnProperty.call(descriptor, 'type')) return descriptor;
  return { type: descriptor };
}
function nestedSchema(descriptor) {
  const spec = fieldSpec(descriptor);
  const type = spec.type;
  if (type instanceof Schema) return type;
  if (Array.isArray(type) && type[0] instanceof Schema) return type[0];
  return null;
}
function embeddedDefinition(descriptor) {
  const spec = fieldSpec(descriptor);
  if (spec.type instanceof Schema) return spec.type.definition;
  if (Array.isArray(spec.type)) {
    if (spec.type[0] instanceof Schema) return spec.type[0].definition;
    if (spec.type[0] && typeof spec.type[0] === 'object') return spec.type[0];
  }
  if (spec.type && typeof spec.type === 'object' && !Array.isArray(spec.type) && typeof spec.type !== 'function') return spec.type;
  return null;
}
function isNested(descriptor) {
  const spec = fieldSpec(descriptor);
  const type = spec.type;
  return type instanceof Schema || Array.isArray(type) || type === Schema.Types.Mixed || type === Schema.Types.Map ||
    (type && typeof type === 'object' && !Array.isArray(type));
}
function sqlType(descriptor) {
  const spec = fieldSpec(descriptor);
  const type = spec.type;
  if (isNested(descriptor)) return 'JSON NULL';
  if (type === String) return spec.unique ? 'VARCHAR(191) NULL' : 'TEXT NULL';
  if (type === Number) return 'DOUBLE NULL';
  if (type === Boolean) return 'TINYINT(1) NULL';
  if (type === Date) return 'DATETIME(3) NULL';
  if (type === 'ObjectId') return 'VARCHAR(64) NULL';
  return 'TEXT NULL';
}
function defaultFor(spec) {
  if (!Object.prototype.hasOwnProperty.call(spec, 'default')) return undefined;
  const value = spec.default;
  if (typeof value === 'function') return value();
  return clone(value);
}
function applyDefaults(definition, target) {
  for (const [key, descriptor] of Object.entries(definition || {})) {
    const spec = fieldSpec(descriptor);
    const childDefinition = embeddedDefinition(descriptor);
    if (target[key] === undefined) {
      const value = defaultFor(spec);
      if (value !== undefined) target[key] = value;
      else if (Array.isArray(spec.type)) target[key] = [];
      else if (childDefinition) target[key] = {};
    }
    if (childDefinition && target[key] && !Array.isArray(target[key])) applyDefaults(childDefinition, target[key]);
    else if (Array.isArray(target[key]) && spec.type && spec.type[0] instanceof Schema) {
      target[key] = target[key].map(item => {
        const value = { ...item };
        applyDefaults(spec.type[0].definition, value);
        return value;
      });
    }
  }
}
function castScalar(value, descriptor) {
  if (value == null) return value;
  const spec = fieldSpec(descriptor);
  const type = spec.type;
  if (type === String) {
    let result = String(value);
    if (spec.trim) result = result.trim();
    if (spec.lowercase) result = result.toLowerCase();
    if (spec.uppercase) result = result.toUpperCase();
    return result;
  }
  if (type === Number) return Number(value);
  if (type === Boolean) return Boolean(value);
  if (type === Date) return value instanceof Date ? value : new Date(value);
  if (type === Schema.Types.ObjectId) return String(value);
  return value;
}
function normalizeDocument(definition, data) {
  const out = {};
  for (const [key, descriptor] of Object.entries(definition || {})) {
    if (data[key] === undefined) continue;
    const spec = fieldSpec(descriptor);
    if (isNested(descriptor)) out[key] = clone(data[key]);
    else if (spec.ref && data[key] && typeof data[key] === 'object') out[key] = data[key]._id || data[key].id || data[key];
    else out[key] = castScalar(data[key], descriptor);
  }
  for (const key of ['_id', 'id', 'createdAt', 'updatedAt']) {
    if (data[key] !== undefined && out[key] === undefined) out[key] = data[key];
  }
  return out;
}
function fromSql(value, descriptor) {
  if (value == null) return value;
  if (isNested(descriptor)) {
    if (typeof value === 'string') { try { return JSON.parse(value); } catch { return value; } }
    return value;
  }
  const type = fieldSpec(descriptor).type;
  if (type === Date) return value instanceof Date ? value : new Date(value);
  if (type === Boolean) return Boolean(value);
  if (type === Number) return Number(value);
  return value;
}

function dottedFields(definition, prefix = '') {
  const result = {};
  for (const [key, descriptor] of Object.entries(definition || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    result[path] = descriptor;
    const child = nestedSchema(descriptor);
    if (child) Object.assign(result, dottedFields(child.definition, path));
  }
  return result;
}
function tableName(modelName) {
  const base = snake(modelName);
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(base)) return `${base}es`;
  return `${base}s`;
}

async function createTables() {
  const modelDirectory = path.join(__dirname, '..', 'models');
  for (const file of fs.readdirSync(modelDirectory).filter(name => name.endsWith('.js'))) {
    require(path.join(modelDirectory, file));
  }
  const pool = getPool();
  for (const [name, Model] of models) {
    const schema = Model.schema;
    const columns = [
      `${quote('_id')} VARCHAR(64) NOT NULL PRIMARY KEY`,
      `${quote('createdAt')} DATETIME(3) NULL`,
      `${quote('updatedAt')} DATETIME(3) NULL`
    ];
    for (const [field, descriptor] of Object.entries(schema.definition)) {
      if (['_id', 'id', 'createdAt', 'updatedAt'].includes(field)) continue;
      columns.push(`${quote(field)} ${sqlType(descriptor)}`);
    }
    const indexes = [];
    for (const [field, descriptor] of Object.entries(schema.definition)) {
      const spec = fieldSpec(descriptor);
      if (spec.unique) indexes.push(`UNIQUE KEY ${quote(`uq_${snake(name)}_${snake(field)}`)} (${quote(field)})`);
      else if (spec.index) indexes.push(`KEY ${quote(`idx_${snake(name)}_${snake(field)}`)} (${quote(field)}${sqlType(descriptor).startsWith('TEXT') ? '(191)' : ''})`);
    }
    for (const index of schema.indexDefinitions) {
      const fields = Object.keys(index.fields || {});
      const names = fields.filter(field => schema.definition[field] && !isNested(schema.definition[field]));
      if (names.length) {
        const unique = index.options && index.options.unique ? 'UNIQUE ' : '';
        indexes.push(`${unique}KEY ${quote(`idx_${snake(name)}_${indexes.length}`)} (${names.map(field => `${quote(field)}${sqlType(schema.definition[field]).startsWith('TEXT') ? '(191)' : ''}`).join(', ')})`);
      }
    }
    const sql = `CREATE TABLE IF NOT EXISTS ${quote(tableName(name))} (${columns.concat(indexes).join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
    await pool.query(sql);
  }
  for (const [name, Model] of models) {
    for (const [field, descriptor] of Object.entries(Model.schema.definition)) {
      const ref = fieldSpec(descriptor).ref;
      if (!ref || isNested(descriptor) || !models.has(ref)) continue;
      const constraintName = `fk_${snake(name)}_${snake(field)}`.slice(0, 60);
      const [existing] = await pool.query(
        'SELECT rc.DELETE_RULE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.TABLE_NAME=? AND tc.CONSTRAINT_NAME=? LIMIT 1',
        [Model.collection, constraintName]
      );
      const deleteRule = fieldSpec(descriptor).required ? 'RESTRICT' : 'SET NULL';
      if (existing.length && existing[0].DELETE_RULE === deleteRule) continue;
      if (existing.length) await pool.query(`ALTER TABLE ${quote(Model.collection)} DROP FOREIGN KEY ${quote(constraintName)}`);
      try {
        await pool.query(`ALTER TABLE ${quote(Model.collection)} ADD CONSTRAINT ${quote(constraintName)} FOREIGN KEY (${quote(field)}) REFERENCES ${quote(tableName(ref))} (${quote('_id')}) ON DELETE ${deleteRule}`);
      } catch (error) {
        if (!['ER_CANNOT_ADD_FOREIGN', 'ER_FK_INCOMPATIBLE_COLUMNS'].includes(error.code)) throw error;
        console.warn(`MySQL foreign key ${constraintName} skipped: ${error.message}`);
      }
    }
  }
}

function compileFilterValue(actual, expected) {
  if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    for (const [operator, value] of Object.entries(expected)) {
      if (operator === '$in' && !value.some(candidate => compileFilterValue(actual, candidate))) return false;
      if (operator === '$nin' && value.some(candidate => compileFilterValue(actual, candidate))) return false;
      if (operator === '$ne' && compileFilterValue(actual, value)) return false;
      if (operator === '$gte' && !(actual >= value)) return false;
      if (operator === '$gt' && !(actual > value)) return false;
      if (operator === '$lte' && !(actual <= value)) return false;
      if (operator === '$lt' && !(actual < value)) return false;
      if (operator === '$exists' && Boolean(actual !== undefined) !== Boolean(value)) return false;
      if (operator === '$regex') {
        const regex = value instanceof RegExp ? value : new RegExp(value, expected.$options || '');
        if (!regex.test(String(actual ?? ''))) return false;
      }
      if (operator === '$elemMatch' && (!Array.isArray(actual) || !actual.some(item => matches(item, value)))) return false;
      if (operator === '$options') continue;
      if (!operator.startsWith('$') && !compileFilterValue(actual && actual[operator], value)) return false;
    }
    return true;
  }
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some(item => String(item) === String(expected));
  if (actual instanceof Date || expected instanceof Date) return new Date(actual).getTime() === new Date(expected).getTime();
  return actual == expected; // Permit matching IDs after string conversion.
}
function matches(document, filter = {}) {
  if (filter == null || typeof filter !== 'object' || Array.isArray(filter) || filter instanceof Date || filter instanceof RegExp) return compileFilterValue(document, filter);
  for (const [key, expected] of Object.entries(filter || {})) {
    if (key === '$or' && !expected.some(item => matches(document, item))) return false;
    else if (key === '$and' && !expected.every(item => matches(document, item))) return false;
    else if (key === '$nor' && expected.some(item => matches(document, item))) return false;
    else if (key.startsWith('$')) continue;
    else if (!compileFilterValue(pathGet(document, key), expected)) return false;
  }
  return true;
}
function applyUpdate(document, update) {
  if (!update || typeof update !== 'object') return document;
  const entries = Object.entries(update);
  if (!entries.some(([key]) => key.startsWith('$'))) {
    for (const [key, value] of entries) pathSet(document, key, clone(value));
    return document;
  }
  for (const [operator, values] of entries) {
    for (const [path, value] of Object.entries(values || {})) {
      const current = pathGet(document, path);
      if (operator === '$set') pathSet(document, path, clone(value));
      else if (operator === '$unset') pathSet(document, path, undefined);
      else if (operator === '$inc') pathSet(document, path, Number(current || 0) + Number(value));
      else if (operator === '$mul') pathSet(document, path, Number(current || 0) * Number(value));
      else if (operator === '$min' && (current === undefined || value < current)) pathSet(document, path, value);
      else if (operator === '$max' && (current === undefined || value > current)) pathSet(document, path, value);
      else if (operator === '$push' || operator === '$addToSet') {
        const array = Array.isArray(current) ? current.slice() : [];
        const additions = value && value.$each ? value.$each : [value];
        for (const item of additions) {
          if (operator === '$push' || !array.some(entry => JSON.stringify(entry) === JSON.stringify(item))) array.push(clone(item));
        }
        pathSet(document, path, array);
      } else if (operator === '$pull') {
        const array = Array.isArray(current) ? current : [];
        pathSet(document, path, array.filter(item => !matches(item, value)));
      }
    }
  }
  return document;
}

function sqlValue(value, descriptor) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (isNested(descriptor)) return JSON.stringify(value);
  if (value instanceof Date) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

class Query {
  constructor(Model, action, filter = {}, update = null, options = {}) {
    this.Model = Model; this.action = action; this.filter = filter || {}; this.update = update; this.options = options;
    this._sort = null; this._limit = null; this._skip = 0; this._projection = null; this._populates = []; this._asLean = false;
  }
  sort(value) { this._sort = value; return this; }
  limit(value) { this._limit = Number(value); return this; }
  skip(value) { this._skip = Number(value); return this; }
  select(value) { this._projection = value; return this; }
  populate(path, select) {
    if (path && typeof path === 'object') this._populates.push({ path: path.path, select: path.select });
    else this._populates.push({ path, select });
    return this;
  }
  lean(value = true) { this._asLean = value; return this; }
  session(session) { this.options.session = session; return this; }
  exec() { return this.run(); }
  then(resolve, reject) { return this.run().then(resolve, reject); }
  catch(reject) { return this.run().catch(reject); }
  async run() {
    if (this.action === 'findOneAndUpdate' || this.action === 'findByIdAndUpdate') return this._updateOne();
    if (this.action === 'findByIdAndDelete' || this.action === 'findOneAndDelete') return this._deleteOne(true);
    if (this.action === 'countDocuments') return this._count();
    if (this.action === 'updateMany') return this._updateMany();
    if (this.action === 'deleteMany') return this._deleteMany();
    if (this.action === 'deleteOne') return this._deleteOne(false);
    const rows = await this.Model._selectAll(this.options.session);
    let docs = rows.filter(row => matches(row, this.filter));
    if (this._sort) {
      const sortFields = Object.entries(this._sort);
      docs.sort((a, b) => {
        for (const [field, direction] of sortFields) {
          const av = pathGet(a, field); const bv = pathGet(b, field);
          if (av < bv) return direction < 0 ? 1 : -1;
          if (av > bv) return direction < 0 ? -1 : 1;
        }
        return 0;
      });
    }
    if (this.action === 'findOne' || this.action === 'findById') docs = docs.slice(0, 1);
    if (this._skip) docs = docs.slice(this._skip);
    if (this._limit != null && this.action === 'find') docs = docs.slice(0, this._limit);
    const result = docs.map(doc => this._projection ? this.Model._project(doc, this._projection) : doc);
    const output = await Promise.all(result.map(async data => {
      const doc = new this.Model(data);
      doc._modified.clear();
      for (const populate of this._populates) await doc.populate(populate.path, populate.select);
      doc._modified.clear();
      return this._asLean ? doc.toObject() : doc;
    }));
    return this.action === 'find' ? output : (output[0] || null);
  }
  async _updateOne() {
    const before = (await this.Model._selectAll(this.options.session, Boolean(this.options.session))).find(row => matches(row, this.filter));
    if (!before) return null;
    const after = applyUpdate(clone(before), this.update);
    after.updatedAt = new Date();
    await this.Model._persist(after, this.options.session);
    const selected = this.options.new || this.options.returnDocument === 'after' ? after : before;
    const doc = new this.Model(selected);
    doc._modified.clear();
    for (const populate of this._populates) await doc.populate(populate.path, populate.select);
    doc._modified.clear();
    return this._asLean ? doc.toObject() : doc;
  }
  async _updateMany() {
    const rows = (await this.Model._selectAll(this.options.session)).filter(row => matches(row, this.filter));
    for (const row of rows) await this.Model._persist({ ...applyUpdate(clone(row), this.update), updatedAt: new Date() }, this.options.session);
    return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length };
  }
  async _deleteOne(returnDocument) {
    const row = (await this.Model._selectAll(this.options.session)).find(item => matches(item, this.filter));
    if (!row) return returnDocument ? null : { acknowledged: true, deletedCount: 0 };
    await this.Model._remove(row._id, this.options.session);
    return returnDocument ? new this.Model(row) : { acknowledged: true, deletedCount: 1 };
  }
  async _deleteMany() {
    const rows = (await this.Model._selectAll(this.options.session)).filter(row => matches(row, this.filter));
    for (const row of rows) await this.Model._remove(row._id, this.options.session);
    return { acknowledged: true, deletedCount: rows.length };
  }
  async _count() { return (await this.Model._selectAll(this.options.session)).filter(row => matches(row, this.filter)).length; }
}

function model(name, schema) {
  if (models.has(name)) return models.get(name);
  class Entity {
    constructor(data = {}) {
      this._modified = new Set(Object.keys(data));
      this._tracking = false;
      applyDefaults(schema.definition, this);
      Object.assign(this, normalizeDocument(schema.definition, data));
      this._id = data._id || data.id || objectId();
      this.id = this._id;
      if (schema.options.timestamps) {
        this.createdAt = data.createdAt || this.createdAt || new Date();
        this.updatedAt = data.updatedAt || this.updatedAt || new Date();
      }
      this._original = clone(this.toObject());
      this._tracking = true;
      return new Proxy(this, {
        set(target, property, value) {
          if (target._tracking && typeof property === 'string' && !property.startsWith('_') && property !== 'id') target._modified.add(property);
          target[property] = value;
          return true;
        }
      });
    }
    isModified(field) { return this._modified.has(field); }
    toObject() {
      const out = {};
      for (const [key, value] of Object.entries(this)) if (!key.startsWith('_') && key !== 'id' && typeof value !== 'function') out[key] = clone(value);
      out._id = this._id;
      return out;
    }
    toJSON() {
      const ret = this.toObject();
      const transform = schema.transforms && schema.transforms.transform;
      if (typeof transform === 'function') transform(this, ret, {});
      if (schema.transforms && schema.transforms.virtuals) ret.id = this.id;
      return ret;
    }
    async save(options = {}) {
      for (const hook of schema.hooks.save) await new Promise((resolve, reject) => {
        let called = false;
        const next = error => { if (called) return; called = true; error ? reject(error) : resolve(); };
        try {
          const result = hook.length ? hook.call(this, next) : hook.call(this);
          if (result && typeof result.then === 'function') result.then(resolve, reject);
          else if (!hook.length) resolve();
        } catch (error) { reject(error); }
      });
      const errors = [];
      for (const [field, descriptor] of Object.entries(schema.definition)) {
        const spec = fieldSpec(descriptor); const value = this[field];
        if (spec.required && (value === undefined || value === null || value === '')) errors.push(`${field} is required`);
        if (value !== undefined && value !== null && Array.isArray(spec.enum) && !spec.enum.includes(value)) errors.push(`${field} must be one of: ${spec.enum.join(', ')}`);
        if (value !== undefined && value !== null && spec.match && !spec.match.test(String(value))) errors.push(`${field} is invalid`);
      }
      if (errors.length) { const error = new Error(errors.join('; ')); error.name = 'ValidationError'; throw error; }
      if (schema.options.timestamps) { this.createdAt ||= new Date(); this.updatedAt = new Date(); }
      const record = this.toObject();
      await Entity._persist(record, options.session);
      this._original = clone(this.toObject()); this._modified.clear();
      return this;
    }
    async deleteOne(options = {}) { return Entity._remove(this._id, options.session); }
    async populate(path, select) {
      for (const entry of String(path).split(/\s+/).filter(Boolean)) {
        const parts = entry.split('.');
        let currentDefinition = schema.definition;
        let descriptor = null;
        for (const part of parts) {
          descriptor = currentDefinition && currentDefinition[part];
          currentDefinition = embeddedDefinition(descriptor);
        }
        const ref = fieldSpec(descriptor).ref;
        if (!ref) continue;
        const RefModel = models.get(ref);
        if (!RefModel) continue;
        const leaf = parts[parts.length - 1];
        const assign = async (target) => {
          if (!target || target[leaf] == null) return;
          const referenced = await RefModel.findById(target[leaf]).select(select || '');
          target[leaf] = referenced;
        };
        const parentParts = parts.slice(0, -1);
        let parents = [this];
        for (const key of parentParts) {
          parents = parents.flatMap(parent => {
            const value = parent == null ? undefined : parent[key];
            return Array.isArray(value) ? value : value == null ? [] : [value];
          });
        }
        await Promise.all(parents.map(assign));
      }
      this._modified.clear();
      return this;
    }
    static get collection() { return tableName(name); }
    static find(filter = {}) { return new Query(Entity, 'find', filter); }
    static findOne(filter = {}) { return new Query(Entity, 'findOne', filter); }
    static findById(id) { return new Query(Entity, 'findById', { _id: id }); }
    static findOneAndUpdate(filter, update, options = {}) { return new Query(Entity, 'findOneAndUpdate', filter, update, options); }
    static findByIdAndUpdate(id, update, options = {}) { return new Query(Entity, 'findByIdAndUpdate', { _id: id }, update, options); }
    static findByIdAndDelete(id) { return new Query(Entity, 'findByIdAndDelete', { _id: id }); }
    static findOneAndDelete(filter) { return new Query(Entity, 'findOneAndDelete', filter); }
    static deleteOne(filter, options = {}) { return new Query(Entity, 'deleteOne', filter, null, options); }
    static deleteMany(filter = {}, options = {}) { return new Query(Entity, 'deleteMany', filter, null, options); }
    static updateMany(filter, update, options = {}) { return new Query(Entity, 'updateMany', filter, update, options); }
    static countDocuments(filter = {}) { return new Query(Entity, 'countDocuments', filter); }
    static async exists(filter = {}) { return Boolean(await Entity.findOne(filter)); }
    static async create(values, options = {}) {
      if (Array.isArray(values)) {
        const result = [];
        for (const value of values) result.push(await new Entity(value).save(options));
        return result;
      }
      return new Entity(values).save(options);
    }
    static async insertMany(values, options = {}) { return Entity.create(values, options); }
    static async _selectAll(session, lockRows = false) {
      const executor = session && session.connection ? session.connection : getPool();
      const [rows] = await executor.query(`SELECT * FROM ${quote(Entity.collection)}${lockRows ? ' FOR UPDATE' : ''}`);
      return rows.map(row => {
        const data = { _id: row._id };
        for (const [field, descriptor] of Object.entries(schema.definition)) {
          if (Object.prototype.hasOwnProperty.call(row, field)) data[field] = fromSql(row[field], descriptor);
        }
        if (row.createdAt) data.createdAt = row.createdAt;
        if (row.updatedAt) data.updatedAt = row.updatedAt;
        return data;
      });
    }
    static async _persist(data, session) {
      const record = normalizeDocument(schema.definition, data);
      record._id = data._id || objectId();
      if (schema.options.timestamps) {
        record.createdAt = data.createdAt || new Date();
        record.updatedAt = data.updatedAt || new Date();
      }
      const fields = ['_id', 'createdAt', 'updatedAt', ...Object.keys(schema.definition).filter(field => !['_id', 'id', 'createdAt', 'updatedAt'].includes(field))];
      const values = fields.map(field => {
        if (field === '_id') return record._id;
        if (field === 'createdAt' || field === 'updatedAt') return record[field] ? (record[field] instanceof Date ? record[field] : new Date(record[field])) : null;
        return sqlValue(record[field], schema.definition[field]);
      });
      const updates = fields.slice(1).map(field => `${quote(field)}=VALUES(${quote(field)})`).join(', ');
      const sql = `INSERT INTO ${quote(Entity.collection)} (${fields.map(quote).join(', ')}) VALUES (${fields.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${updates}`;
      const executor = session && session.connection ? session.connection : getPool();
      try {
        await executor.execute(sql, values);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') error.code = 11000;
        throw error;
      }
    }
    static async _remove(id, session) {
      const executor = session && session.connection ? session.connection : getPool();
      await executor.execute(`DELETE FROM ${quote(Entity.collection)} WHERE ${quote('_id')}=?`, [String(id)]);
    }
    static _project(document, projection) {
      const fields = typeof projection === 'string' ? projection.split(/\s+/).filter(Boolean) : Object.keys(projection || {}).filter(key => projection[key]);
      const excluded = typeof projection === 'string' ? projection.split(/\s+/).filter(value => value.startsWith('-')).map(value => value.slice(1)) : Object.keys(projection || {}).filter(key => projection[key] === 0);
      if (excluded.length) { const result = clone(document); for (const key of excluded) delete result[key]; return result; }
      if (!fields.length) return document;
      const result = { _id: document._id };
      for (const field of fields.filter(value => !value.startsWith('-'))) { const value = pathGet(document, field); if (value !== undefined) pathSet(result, field, value); }
      return result;
    }
  }
  Entity.modelName = name;
  Entity.schema = schema;
  Object.assign(Entity.prototype, schema.methods);
  models.set(name, Entity);
  return Entity;
}

class Session {
  constructor() { this.connection = null; this.transactionContext = null; }
  async startTransaction() {
    this.connection = await getConnection();
    await this.connection.beginTransaction();
  }
  async commitTransaction() { if (this.connection) await this.connection.commit(); }
  async abortTransaction() { if (this.connection) await this.connection.rollback(); }
  async endSession() { if (this.connection) { this.connection.release(); this.connection = null; } }
}

module.exports = {
  Schema,
  Types: Schema.Types,
  models,
  model,
  Types: { ObjectId, Mixed: Schema.Types.Mixed, Map: Schema.Types.Map },
  connection: { get readyState() { return require('../config/mysql-pool').isConnected() ? 1 : 0; } },
  async connect() { const pool = getPool(); await pool.query('SELECT 1'); await createTables(); require('../config/mysql-pool').setConnected(true); return module.exports; },
  async disconnect() {
    const mysqlPool = require('../config/mysql-pool');
    if (!mysqlPool.isConnected()) return;
    await getPool().end();
    mysqlPool.setConnected(false);
  },
  async startSession() { return new Session(); },
  async createTables() { return createTables(); }
};
