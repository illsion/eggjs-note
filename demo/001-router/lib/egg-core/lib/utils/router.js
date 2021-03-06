'use strict';

const fs = require('fs');
const path = require('path');
const Koa = require('koa');
const KoaRouter = require('koa-router');
const is = require('is-type-of');
const inflection = require('inflection');
const utility = require('utility');
const co = require('co');
const convert = require('koa-convert');

const utils = {
  methods: [ 'head', 'options', 'get', 'put', 'patch', 'post', 'delete', 'all' ],

  middleware(fn) {
    return is.generatorFunction(fn) ? convert(fn) : fn;
  },

  async callFn(fn, args, ctx) {
    args = args || [];
    if (!is.function(fn)) return;
    if (is.generatorFunction(fn)) fn = co.wrap(fn);
    return ctx ? fn.call(ctx, ...args) : fn(...args);
  },
};

const { methods } = utils;

const REST_MAP = {
  index: {
    suffix: '',
    method: 'GET',
  },
  new: {
    namePrefix: 'new_',
    member: true,
    suffix: 'new',
    method: 'GET',
  },
  create: {
    suffix: '',
    method: 'POST',
  },
  show: {
    member: true,
    suffix: ':id',
    method: 'GET',
  },
  edit: {
    member: true,
    namePrefix: 'edit_',
    suffix: ':id/edit',
    method: 'GET',
  },
  update: {
    member: true,
    namePrefix: '',
    suffix: ':id',
    method: [ 'PATCH', 'PUT' ],
  },
  destroy: {
    member: true,
    namePrefix: 'destroy_',
    suffix: ':id',
    method: 'DELETE',
  },
};


class Router extends KoaRouter {
  constructor(opts, app) {
    super(opts);
    this.app = app;
    this.patchRouterMethod();
  }

  /** 
   * 兼容处理路由方法
   * @name {Function} patchRouterMethod
   */
  patchRouterMethod() {
    // patch router methods to support generator function middleware and string controller
    methods.concat([ 'all' ]).forEach(method => {
      this[method] = (...args) => {
        const splited = spliteAndResolveRouterParams({ args, app: this.app });
        // format and rebuild params
        args = splited.prefix.concat(splited.middlewares);
        return super[method](...args);
      };
    });
  }

  /**
   * 兼容处理继承 koa-router 的 register 方法
   * Create and register a route.
   * @param {String} path - url path
   * @param {Array} methods - Array of HTTP verbs
   * @param {Array} middlewares -
   * @param {Object} opts -
   * @return {Route} this
   */
  register(path, methods, middlewares, opts) {
    // patch register to support generator function middleware and string controller
    middlewares = Array.isArray(middlewares) ? middlewares : [ middlewares ];
    middlewares = convertMiddlewares(middlewares, this.app);
    path = Array.isArray(path) ? path : [ path ];
    path.forEach(p => super.register(p, methods, middlewares, opts));
    return this;
  }

  /**
   * restful router api
   * @param {String} name - Router name
   * @param {String} prefix - url prefix
   * @param {Function} middleware - middleware or controller
   * @return {Router} return route object.
   */
  resources(...args) {
    const splited = spliteAndResolveRouterParams({ args, app: this.app });
    const middlewares = splited.middlewares;
    // last argument is Controller object
    const controller = splited.middlewares.pop();

    let name = '';
    let prefix = '';
    if (splited.prefix.length === 2) {
      // router.get('users', '/users')
      name = splited.prefix[0];
      prefix = splited.prefix[1];
    } else {
      // router.get('/users')
      prefix = splited.prefix[0];
    }

    for (const key in REST_MAP) {
      const action = controller[key];
      if (!action) continue;

      const opts = REST_MAP[key];
      let formatedName;
      if (opts.member) {
        formatedName = inflection.singularize(name);
      } else {
        formatedName = inflection.pluralize(name);
      }
      if (opts.namePrefix) {
        formatedName = opts.namePrefix + formatedName;
      }
      prefix = prefix.replace(/\/$/, '');
      const path = opts.suffix ? `${prefix}/${opts.suffix}` : prefix;
      const method = Array.isArray(opts.method) ? opts.method : [ opts.method ];
      this.register(path, method, middlewares.concat(action), { name: formatedName });
    }

    return this;
  }
}


/**
 * 统一处理封装router的参数
 * @param  {Object} options inputs
 * @param {Object} options.args router params
 * @param {Object} options.app egg application instance
 * @return {Object} prefix and middlewares
 */
function spliteAndResolveRouterParams({ args, app }) {
  let prefix;
  let middlewares;
  if (args.length >= 3 && (is.string(args[1]) || is.regExp(args[1]))) {
    // app.get(name, url, [...middleware], controller)
    prefix = args.slice(0, 2);
    middlewares = args.slice(2);
  } else {
    // app.get(url, [...middleware], controller)
    prefix = args.slice(0, 1);
    middlewares = args.slice(1);
  }
  // resolve controller
  const controller = middlewares.pop();
  middlewares.push(resolveController(controller, app));
  return { prefix, middlewares };
}


/**
 * 封装兼容处理 controller
 * resolve controller from string to function
 * @param  {String|Function} controller input controller
 * @param  {Application} app egg application instance
 * @return {Function} controller function
 */
function resolveController(controller, app) {
  if (is.string(controller)) {
    const actions = controller.split('.');
    let obj = app.controller;
    actions.forEach(key => {
      obj = obj[key];
      if (!obj) throw new Error(`controller '${controller}' not exists`);
    });
    controller = obj;
  }
  // ensure controller is exists
  if (!controller) throw new Error('controller not exists');
  return controller;
}


/**
 * 封装兼容 Generator Function 类型的中间件
 * @param  {Array} middlewares middlewares and controller(last middleware)
 * @param  {Application} app  egg application instance
 * @return {Array} middlewares
 */
function convertMiddlewares(middlewares, app) {
  // ensure controller is resolved
  const controller = resolveController(middlewares.pop(), app);
  // make middleware support generator function
  middlewares = middlewares.map(utils.middleware);
  const wrappedController = (ctx, next) => {
    return utils.callFn(controller, [ ctx, next ], ctx);
  };
  return middlewares.concat([ wrappedController ]);
}

module.exports = Router;
