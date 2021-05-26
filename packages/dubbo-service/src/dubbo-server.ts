/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import net, { Socket } from 'net'
import ip from 'ip'
import debug from 'debug'
import qs from 'querystring'
import compose, { Middleware } from 'koa-compose'
import { Retry, util } from '@apache/dubbo-common'
import { IRegistry } from '@apache/dubbo-registry'
import {
  DecodeBuffer,
  decodeDubboRequest,
  DubboResponseEncoder,
  DUBBO_RESPONSE_STATUS,
  HeartBeat,
  Request
} from '@apache/dubbo-serialization'
import Context from './context'
import { randomPort } from './port'
import {
  DubboServiceClazzName,
  IDubboServerProps,
  IDubboService,
  TDubboServiceInterface,
  TDubboServiceUrl
} from './types'
import { DubboSetting } from './dubbo-setting'

const log = debug('dubbo-server ~')

/**
 * DubboServer - expose dubbo service by nodejs
 * - expose dubbo service
 * - connect zookeeper or nacos, registry service
 * - router => find service
 * - extend middleware
 * - keep heartbeat with consumer
 */

export default class DubboServer {
  private resolve: Function
  private reject: Function
  private readyPromise: Promise<void>

  private retry: Retry
  private port: number
  private server: net.Server
  private dubboSetting: DubboSetting
  private registry: IRegistry<any>
  private services: { [name in string]: IDubboService }
  private serviceRouter: Map<DubboServiceClazzName, Array<IDubboService>>
  private readonly middlewares: Array<Middleware<Context>>

  constructor(props: IDubboServerProps) {
    this.checkProps(props)

    // init ready promise
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })

    // init dubbo setting
    this.dubboSetting = props.dubboSetting

    // init registry
    this.registry = props.registry

    // init service
    this.serviceRouter = new Map()
    this.services = props.services

    // init middlewares
    this.middlewares = []

    // set retry container
    this.retry = new Retry({
      retry: () => this.listen(),
      end: () => {
        throw new Error(
          'Oops, dubbo server can not start, can not find available port'
        )
      }
    })

    process.nextTick(() => {
      // listen tcp server
      this.listen()
    })
  }

  // ~~~~~~~~~~~~~~~~~~private~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  private checkProps(props: IDubboServerProps) {
    if (!util.isObj(props.registry)) {
      throw new Error(`Please specify registry, use Zk or Nacos init registry`)
    }

    if (!util.isObj(props.services)) {
      throw new Error(`Please specify dubbo service`)
    }
  }

  /**
   * start tcp server
   */
  private listen = async () => {
    this.port = await randomPort()
    log(`init service with port: %d`, this.port)

    this.server = net
      .createServer(this.handleSocketRequest)
      .listen(this.port, () => {
        log('start dubbo-server with port %d', this.port)
        this.resolve()
        this.retry.reset()
        this.registerServices()
      })
      .on('error', (err) => {
        log(`server listen %d port err: %s`, this.port, err)
        try {
          this.retry.start()
        } catch (err) {
          this.reject(err)
        }
      })
  }

  /**
   * recevice tcp message
   * @param socket
   */
  private handleSocketRequest = (socket: Socket) => {
    log('tcp socket establish connection %s', socket.remoteAddress)

    // init heartbeat
    const heartbeat = HeartBeat.from({
      type: 'response',
      transport: socket,
      onTimeout: () => socket.destroy()
    })

    DecodeBuffer.from(socket, 'dubbo-server').subscribe(async (data) => {
      // send heartbeat
      if (HeartBeat.isHeartBeat(data)) {
        log(`receive socket client heartbeat`)
        heartbeat.emit()
        return
      }

      const ctx = await this.invokeComposeChainRequest(data)
      heartbeat.setWriteTimestamp()
      socket.write(new DubboResponseEncoder(ctx).encode())
    })
  }

  /**
   * invoke compose middleware chain, the same as koa
   * @param data
   * @returns
   */
  private async invokeComposeChainRequest(data: Buffer) {
    const request = decodeDubboRequest(data)
    const service = this.matchService(request)
    const ctx = new Context(request)

    const {
      methodName,
      attachment: { path, group = '', version }
    } = request

    // service not found
    if (!service) {
      ctx.status = DUBBO_RESPONSE_STATUS.SERVICE_NOT_FOUND
      ctx.body = new Error(
        `Service not found with ${path} and ${methodName}, group:${group}, version:${version}`
      )
      return ctx
    }

    const middlewares = [
      ...this.middlewares,
      async function handleRequest(ctx: Context) {
        const method = service.methods[request.methodName]
        ctx.status = DUBBO_RESPONSE_STATUS.OK
        try {
          const res = await method.apply(service, [
            ...(request.args || []),
            ctx
          ])
          // check hessian type
          if (!util.checkRetValHessian(res)) {
            throw new Error(
              `${path}#${methodName} return value not hessian type`
            )
          }
          this.body = res
        } catch (err) {
          log(`handle request error %s`, err)
          this.body = err
        }
      }
    ]

    log('middleware stack =>', middlewares)
    const fn = compose(middlewares)

    try {
      await fn(ctx)
    } catch (err) {
      log(err)
      ctx.status = DUBBO_RESPONSE_STATUS.SERVER_ERROR
      ctx.body = err
    }
    return ctx
  }

  /**
   * register service into zookeeper or nacos
   */
  private async registerServices() {
    await this.registry.ready().catch((err) => {
      log('registry service error %s', err)
      throw err
    })

    const registrySerivceList = [] as Array<{
      dubboServiceInterface: TDubboServiceInterface
      dubboServiceUrl: TDubboServiceUrl
    }>
    for (let [dubboServiceShortName, service] of Object.entries(
      this.services
    )) {
      const meta = this.dubboSetting
        ? this.dubboSetting.getDubboSetting({
            dubboServiceShortName,
            dubboServiceInterface: service.dubboInterface
          })
        : { group: '', version: '0.0.0' }
      service.group = meta.group
      service.version = meta.version

      // collect service router
      if (this.serviceRouter.has(service.dubboInterface)) {
        this.serviceRouter.get(service.dubboInterface).push(service)
      } else {
        this.serviceRouter.set(service.dubboInterface, [service])
      }

      const dubboServiceUrl = this.buildUrl(service)
      log('registry dubbo service url %s', dubboServiceUrl)
      registrySerivceList.push({
        dubboServiceInterface: service.dubboInterface,
        dubboServiceUrl
      })
    }

    // register service to registry, such as zookeeper or nacos
    this.registry.registyServices(registrySerivceList)
  }

  /**
   * build dubbo service url
   *
   * @param service
   * @returns
   */
  private buildUrl(service: IDubboService) {
    const ipAddr = ip.address()
    const { dubboInterface, group, version, methods } = service
    const methodName = Object.keys(methods).join()

    return (
      `dubbo://${ipAddr}:${this.port}/${dubboInterface}?` +
      qs.stringify({
        group,
        version,
        method: methodName,
        side: 'provider',
        pid: process.pid,
        generic: false,
        protocal: 'dubbo',
        dynamic: true,
        category: 'providers',
        anyhost: true,
        timestamp: Date.now()
      })
    )
  }

  /**
   * router, map request to service
   * @param request
   * @returns
   */
  private matchService(request: Request) {
    const { methodName } = request
    const {
      attachment: { path, group = '', version = '0.0.0' }
    } = request

    const serviceList = this.serviceRouter.get(path) || []
    return serviceList.find((s) => {
      const isSameVersion = version == '*' || s.version === version
      const isSameGroup = group === s.group
      return s.methods[methodName] && isSameGroup && isSameVersion
    })
  }

  // ~~~~~~~~~~~~~public method ~~~~~~~~~~~~~~~~~~~

  /**
   * static factory method
   *
   * @param props
   * @returns
   */
  public static from(props: IDubboServerProps) {
    return new DubboServer(props)
  }

  /**
   * close current tcp servce
   */
  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.registry.close()
      this.server?.close((err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  /**
   * extends middleware
   *
   * @param fn
   */
  public use(fn: Middleware<Context>) {
    if (typeof fn != 'function') {
      throw new TypeError('middleware must be a function')
    }
    log('use middleware %s', (fn as any)._name || fn.name || '-')
    this.middlewares.push(fn)
    return this
  }

  public ready() {
    return this.readyPromise
  }
}
