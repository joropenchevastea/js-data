import {
  addHiddenPropsToTarget,
  classCallCheck,
  extend,
  fillIn,
  get,
  getSuper,
  isArray,
  isBrowser,
  isUndefined,
  set
} from './utils'
import {
  belongsToType,
  hasManyType,
  hasOneType
} from './decorators'
import Container from './Container'
import LinkedCollection from './LinkedCollection'

const DATASTORE_DEFAULTS = {
  linkRelations: isBrowser
}

/**
 * The `DataStore` class is an extension of {@link Container}. Not only does
 * `DataStore` manage mappers, but also collections. `DataStore` implements the
 * asynchronous {@link Mapper} methods, such as {@link Mapper#find} and
 * {@link Mapper#create}. If you use the asynchronous `DataStore` methods
 * instead of calling them directly on the mappers, then the results of the
 * method calls will be inserted into the store's collections. You can think of
 * a `DataStore` as an [Identity Map](https://en.wikipedia.org/wiki/Identity_map_pattern)
 * for the [ORM](https://en.wikipedia.org/wiki/Object-relational_mapping)
 * (the Mappers).
 *
 * ```javascript
 * import {DataStore} from 'js-data'
 * ```
 *
 * @example
 * import {DataStore} from 'js-data'
 * import HttpAdapter from 'js-data-http'
 * const store = new DataStore()
 * const UserMapper = store.defineMapper('user')
 *
 * // Call "find" on "UserMapper" (Stateless ORM)
 * UserMapper.find(1).then(function (user) {
 *   // retrieved a "user" record via the http adapter, but that's it
 *
 *   // Call "find" on "store" for the "user" mapper (Stateful DataStore)
 *   return store.find('user', 1)
 * }).then(function (user) {
 *   // not only was a "user" record retrieved, but it was added to the
 *   // store's "user" collection
 *   const cachedUser = store.getCollection('user').get(1)
 *   user === cachedUser // true
 * })
 *
 * @class DataStore
 * @extends Container
 * @param {Object} [opts] Configuration options. See {@link Container}.
 * @return {DataStore}
 */
const DataStore = Container.extend({
  constructor (opts) {
    const self = this
    classCallCheck(self, DataStore)

    getSuper(self).call(self, opts)
    self.CollectionClass = self.CollectionClass || LinkedCollection
    self._collections = {}
    fillIn(self, DATASTORE_DEFAULTS)
    return self
  },

  /**
   * TODO
   *
   * @name DataStore#_end
   * @method
   * @private
   * @param {string} name Name of the {@link LinkedCollection} to which to
   * add the data.
   * @param {Object} data TODO.
   * @param {Object} [opts] Configuration options.
   * @return {(Object|Array)} Result.
   */
  _end (name, data, opts) {
    if (opts.raw) {
      data.data = this.getCollection(name).add(data.data, opts)
      return data
    } else {
      data = this.getCollection(name).add(data, opts)
    }
    return data
  },

  /**
   * TODO
   *
   * @name DataStore#create
   * @method
   * @param {string} name Name of the {@link Mapper} to target.
   * @param {Object} record Passed to {@link Mapper#create}.
   * @param {Object} [opts] Passed to {@link Mapper#create}. See
   * {@link Mapper#create} for more configuration options.
   * @return {Promise}
   */
  create (name, record, opts) {
    const self = this
    opts || (opts = {})
    return getSuper(self).create(name, record, opts).then(function (data) {
      return self._end(name, data, opts)
    })
  },

  /**
   * TODO
   *
   * @name DataStore#createMany
   * @method
   * @param {string} name Name of the {@link Mapper} to target.
   * @param {Array} records Passed to {@link Mapper#createMany}.
   * @param {Object} [opts] Passed to {@link Mapper#createMany}. See
   * {@link Mapper#createMany} for more configuration options.
   * @return {Promise}
   */
  createMany (name, records, opts) {
    const self = this
    opts || (opts = {})
    return getSuper(self).createMany(name, records, opts).then(function (data) {
      return self._end(name, data, opts)
    })
  },

  defineMapper (name, opts) {
    const self = this
    const mapper = getSuper(self).prototype.defineMapper.call(self, name, opts)
    mapper.relationList = mapper.relationList || []

    // The datastore uses a subclass of Collection that is "datastore-aware"
    const collection = self._collections[name] = new self.CollectionClass(null, {
      // Make sure the collection has somewhere to store "added" timestamps
      _added: {},
      // Give the collection a reference to this datastore
      datastore: self,
      // The mapper tied to the collection
      mapper
    })

    // Create a secondary index on the "added" timestamps of records in the
    // collection
    collection.createIndex('addedTimestamps', ['$'], {
      fieldGetter (obj) {
        return collection._added[collection.recordId(obj)]
      }
    })

    const linkRelations = self.linkRelations

    if (linkRelations) {
      mapper.relationList.forEach(function (def) {
        const relation = def.relation
        const localField = def.localField
        const path = `links.${localField}`
        const foreignKey = def.foreignKey
        const type = def.type
        const link = isUndefined(def.link) ? linkRelations : def.link
        const updateOpts = { index: foreignKey }
        let descriptor

        if (type === belongsToType) {
          if (!collection.indexes[foreignKey]) {
            collection.createIndex(foreignKey)
          }

          descriptor = {
            get () {
              const _self = this
              if (!_self._get('$') || !link) {
                return _self._get(path)
              }
              const key = get(_self, foreignKey)
              const item = isUndefined(key) ? undefined : self.getCollection(relation).get(key)
              _self._set(path, item)
              return item
            },
            set (record) {
              const _self = this
              _self._set(path, record)
              set(_self, foreignKey, self.getCollection(relation).recordId(record))
              collection.updateIndex(_self, updateOpts)
              return get(_self, localField)
            }
          }
        } else if (type === hasManyType) {
          const localKeys = def.localKeys
          const foreignKeys = def.foreignKeys

          // TODO: Handle case when belongsTo relation isn't ever defined
          if (self._collections[relation] && foreignKey && !self.getCollection(relation).indexes[foreignKey]) {
            self.getCollection(relation).createIndex(foreignKey)
          }

          descriptor = {
            get () {
              const _self = this
              if (!_self._get('$') || !link) {
                return _self._get(path)
              }
              const key = collection.recordId(_self)
              let items
              const relationCollection = self.getCollection(relation)

              if (foreignKey) {
                // Really fast retrieval
                items = relationCollection.getAll(key, {
                  index: foreignKey
                })
              } else if (localKeys) {
                const keys = get(_self, localKeys) || []
                const args = isArray(keys) ? keys : Object.keys(keys)
                // Really fast retrieval
                items = relationCollection.getAll.apply(relationCollection, args)
              } else if (foreignKeys) {
                const query = {}
                set(query, `where.${foreignKeys}.contains`, key)
                // Make a much slower retrieval
                items = relationCollection.filter(query)
              }

              _self._set(path, items)
              return items
            },
            set (records) {
              const _self = this
              const key = collection.recordId(_self)
              const relationCollection = self.getCollection(relation)
              _self._set(path, records)

              if (foreignKey) {
                records.forEach(function (record) {
                  set(record, foreignKey, key)
                  relationCollection.updateIndex(record, updateOpts)
                })
              } if (localKeys) {
                set(_self, localKeys, records.map(function (record) {
                  return relationCollection.recordId(record)
                }))
              } else if (foreignKeys) {
                records.forEach(function (record) {
                  const keys = get(record, foreignKeys)
                  if (keys) {
                    if (keys.indexOf(key) === -1) {
                      keys.push(key)
                    }
                  } else {
                    set(record, foreignKeys, [key])
                  }
                })
              }
              return get(_self, localField)
            }
          }
        } else if (type === hasOneType) {
          descriptor = {
            get () {
              const _self = this
              if (!_self._get('$') || !link) {
                return _self._get(path)
              }
              const key = collection.recordId(_self)
              const items = self.getCollection(relation).getAll(key, {
                index: foreignKey
              })
              const item = items.length ? items[0] : undefined
              _self._set(path, item)
              return item
            },
            set (record) {
              const _self = this
              const key = collection.recordId(_self)
              _self._set(path, record)
              set(record, foreignKey, key)
              self.getCollection(relation).updateIndex(record, updateOpts)
              return get(_self, localField)
            }
          }
        }

        if (descriptor) {
          descriptor.enumerable = isUndefined(def.enumerable) ? true : def.enumerable
          if (def.get) {
            let origGet = descriptor.get
            descriptor.get = function () {
              return def.get(def, this, (...args) => origGet.apply(this, args))
            }
          }
          if (opts.set) {
            let origSet = descriptor.set
            descriptor.set = function (related) {
              return def.set(def, this, related, (value) => origSet.call(this, value === undefined ? related : value))
            }
          }
          Object.defineProperty(mapper.RecordClass.prototype, localField, descriptor)
        }
      })
    }

    return mapper
  },

  /**
   * TODO
   *
   * @name DataStore#destroy
   * @method
   * @param {string} name - Name of the {@link Mapper} to target.
   * @param {(string|number)} id - Passed to {@link Mapper#destroy}.
   * @param {Object} [opts] - Passed to {@link Mapper#destroy}. See
   * {@link Mapper#destroy} for more configuration options.
   * @return {Promise}
   */
  destroy (name, id, opts) {
    const self = this
    opts || (opts = {})
    return getSuper(self).destroy(name, id, opts).then(function (data) {
      if (opts.raw) {
        data.data = self.getCollection(name).remove(id, opts)
      } else {
        data = self.getCollection(name).remove(id, opts)
      }
      return data
    })
  },

  /**
   * TODO
   *
   * @name DataStore#destroyAll
   * @method
   * @param {string} name - Name of the {@link Mapper} to target.
   * @param {Object} [query] - Passed to {@link Mapper#destroyAll}.
   * @param {Object} [opts] - Passed to {@link Mapper#destroyAll}. See
   * {@link Mapper#destroyAll} for more configuration options.
   * @return {Promise}
   */
  destroyAll (name, query, opts) {
    const self = this
    opts || (opts = {})
    return getSuper(self).destroyAll(name, query, opts).then(function (data) {
      if (opts.raw) {
        data.data = self.getCollection(name).removeAll(query, opts)
      } else {
        data = self.getCollection(name).removeAll(query, opts)
      }
      return data
    })
  },

  /**
   * TODO
   *
   * @name DataStore#find
   * @method
   * @param {string} name - Name of the {@link Mapper} to target.
   * @param {(string|number)} id - Passed to {@link Mapper#find}.
   * @param {Object} [opts] - Passed to {@link Mapper#find}.
   * @return {Promise}
   */
  find (name, id, opts) {
    const self = this
    opts || (opts = {})
    return getSuper(self).find(name, id, opts).then(function (data) {
      return self._end(name, data, opts)
    })
  },

  /**
   * TODO
   *
   * @name DataStore#findAll
   * @method
   * @param {string} name - Name of the {@link Mapper} to target.
   * @param {Object} [query] - Passed to {@link Model.findAll}.
   * @param {Object} [opts] - Passed to {@link Model.findAll}.
   * @return {Promise}
   */
  findAll (name, query, opts) {
    const self = this
    opts || (opts = {})
    return getSuper(self).findAll(name, query, opts).then(function (data) {
      return self._end(name, data, opts)
    })
  },

  /**
   * TODO
   *
   * @name DataStore#getCollection
   * @method
   * @param {string} name Name of the {@link DataStoreCollection} to retrieve.
   * @return {DataStoreCollection}
   */
  getCollection (name) {
    const collection = this._collections[name]
    if (!collection) {
      throw new ReferenceError(`${name} is not a registered collection!`)
    }
    return collection
  },

  /**
   * TODO
   *
   * @name DataStore#update
   * @method
   * @param {string} name - Name of the {@link Mapper} to target.
   * @param {(string|number)} id - Passed to {@link Mapper#update}.
   * @param {Object} record - Passed to {@link Mapper#update}.
   * @param {Object} [opts] - Passed to {@link Mapper#update}. See
   * {@link Mapper#update} for more configuration options.
   * @return {Promise}
   */
  update (name, id, record, opts) {
    const self = this
    opts || (opts = {})
    return getSuper(self).update(name, id, record, opts).then(function (data) {
      return self._end(name, data, opts)
    })
  },

  /**
   * TODO
   *
   * @name DataStore#updateAll
   * @method
   * @param {string} name - Name of the {@link Mapper} to target.
   * @param {Object?} query - Passed to {@link Model.updateAll}.
   * @param {Object} props - Passed to {@link Model.updateAll}.
   * @param {Object} [opts] - Passed to {@link Model.updateAll}. See
   * {@link Model.updateAll} for more configuration options.
   * @return {Promise}
   */
  updateAll (name, query, props, opts) {
    const self = this
    opts || (opts = {})
    return getSuper(self).updateAll(name, query, props, opts).then(function (data) {
      return self._end(name, data, opts)
    })
  },

  /**
   * TODO
   *
   * @name DataStore#updateMany
   * @method
   * @param {string} name Name of the {@link Mapper} to target.
   * @param {(Object[]|Record[])} records Passed to {@link Mapper#updateMany}.
   * @param {Object} [opts] Passed to {@link Mapper#updateMany}. See
   * {@link Mapper#updateMany} for more configuration options.
   * @return {Promise}
   */
  updateMany (name, records, opts) {
    const self = this
    opts || (opts = {})
    return getSuper(self).updateMany(records, opts).then(function (data) {
      return self._end(name, data, opts)
    })
  }
})

DataStore.prototype.defineResource = DataStore.prototype.defineMapper

/**
 * Create a DataStore subclass.
 *
 * ```javascript
 * var MyDataStore = DataStore.extend({
 *   foo: function () { return 'bar' }
 * })
 * var store = new MyDataStore()
 * store.foo() // "bar"
 * ```
 *
 * @name DataStore.extend
 * @method
 * @param {Object} [props={}] Properties to add to the prototype of the
 * subclass.
 * @param {Object} [classProps={}] Static properties to add to the subclass.
 * @return {Function} Subclass of DataStore.
 */
DataStore.extend = extend

const toProxy = [
  'add',
  'between',
  'createIndex',
  'filter',
  'get',
  'getAll',
  'query',
  'remove',
  'removeAll',
  'toJson'
]

const methods = {}

toProxy.forEach(function (method) {
  methods[method] = function (name, ...args) {
    return this.getCollection(name)[method](...args)
  }
})

methods.inject = function (...args) {
  // TODO: Fix logging
  console.warn('deprecated')
  return this.add(...args)
}

addHiddenPropsToTarget(DataStore.prototype, methods)

export {
  DataStore as default
}
