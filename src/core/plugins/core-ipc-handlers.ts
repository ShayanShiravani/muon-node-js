import CallablePlugin from './base/callable-plugin.js'
import {remoteApp, remoteMethod, ipcMethod} from './base/app-decorators.js'
import System from "./system.js";
import AppManager from "./app-manager.js";
import GatewayInterface from "./gateway-Interface.js";
import BaseAppPlugin from "./base/base-app-plugin.js";
import {timeout} from '../../utils/helpers.js'
import {AppContext, AppRequest, JsonPublicKey} from "../../common/types";

export const IpcMethods = {
  ForwardRemoteCall: 'forward-remote-call',
  GetTssKey: 'get-tss-key',
  GetAppId: 'get-app-id',
  GetAppContext: 'get-app-context',
  GetAppOldestContext: 'get-app-oldest-context',
  GetAppTimeout: 'get-app-timeout',
  QueryAppAllContext: 'query-app-all-context',
  IsDeploymentExcerpt: 'is-deployment-excerpt',
  ShieldConfirmedRequest: 'shield-confirmed-request',
  EnsureAppTssKeyExist: 'ensure-app-tss-key-exist',
  FindNAvailablePartners: 'find-n-available-partner',
  VerifyRequestSignature: 'verify-req-sign',
} as const;
type IpcKeys = keyof typeof IpcMethods;
export type CoreIpcMethod = typeof IpcMethods[IpcKeys];

@remoteApp
class CoreIpcHandlers extends CallablePlugin {

  get remoteCallPlugin() {
    return this.muon.getPlugin('remote-call');
  }

  get systemPlugin(): System {
    return this.muon.getPlugin('system');
  }

  get appManager(): AppManager {
    return this.muon.getPlugin('app-manager');
  }

  @ipcMethod(IpcMethods.ForwardRemoteCall)
  async __onRemoteCallForward({data, callerInfo}) {
    // console.log(`CoreIpcHandlers.__onRemoteCallForward`, data, callerInfo)
    const {method, params, options} = data;
    if(this.remoteCallPlugin.listenerCount(method) < 1){
      throw `Remote method [${method}] handler not defined`
    }
    return await this.remoteCallPlugin.handleCall(undefined, method, params, callerInfo, null)
  }

  @ipcMethod(IpcMethods.GetTssKey)
  async __onGetTssKeyRequest(data: {keyId: string}, callerInfo) {
    let key = await this.muon.getPlugin('tss-plugin').getSharedKey(data.keyId)
    return key.toSerializable();
  }

  @ipcMethod(IpcMethods.GetAppId)
  async __onGetAppId(data: {appName: string}): Promise<string> {
    const appId = this.muon.getAppIdByName(data.appName)
    return appId || "0";
  }

  /**
   * Return local app context
   * @param appName
   */
  @ipcMethod(IpcMethods.GetAppContext)
  async __getAppContext(params: {appName: string, seed: string}) {
    const {appName, seed} = params
    const appId = await this.muon.getAppIdByName(appName)
    if(appId === '0')
      return null;
    return await this.appManager.getAppContext(appId, seed)
  }

  /**
   * Return local app context
   * @param appName
   */
  @ipcMethod(IpcMethods.GetAppOldestContext)
  async __getAppOldestContext(params: {appName: string}) {
    const {appName} = params
    const appId = await this.muon.getAppIdByName(appName)
    if(appId === '0')
      return null;
    return await this.appManager.getAppOldestContext(appId)
  }

  /**
   * Return local app context
   * @param appName
   */
  @ipcMethod(IpcMethods.GetAppTimeout)
  async __getAppTimeout(appName: string) {
    const app = await this.muon.getAppByName(appName)
    if(!app)
      return 0;
    return app.requestTimeout || 0
  }

  /**
   * If app context not found locally, it's need to query muon network to find it.
   * @param appName
   */
  @ipcMethod(IpcMethods.QueryAppAllContext)
  async __queryAppAllContext(appName: string): Promise<AppContext[]> {
    const appId = await this.__onGetAppId({appName})
    if(appId === '0')
      return [];
    return await this.appManager.queryAndLoadAppContext(appId)
  }

  @ipcMethod(IpcMethods.IsDeploymentExcerpt)
  async __isDeploymentExcerpt(data: {appName: string, method: string}) {
    const gp: GatewayInterface = this.muon.getPlugin('gateway-interface')
    return gp.getActualHandlerMethod(data.appName, data.method) !== 'default'
  }

  @ipcMethod(IpcMethods.ShieldConfirmedRequest)
  async __shieldConfirmedRequest(request) {
    const app: BaseAppPlugin = this.muon.getAppById(request.appId)
    if(!app)
      throw `CoreIpcHandler.__shieldConfirmedRequest Error: app not found ${request.appId}`
    return await app.shieldConfirmedRequest(request)
  }

  @ipcMethod(IpcMethods.EnsureAppTssKeyExist)
  async __ensureAppTssKeyExist(data: {appId: string, seed: string}) {
    const {appId, seed} = data;
    console.log(`CoreIpcHandler.__ensureAppTssKeyExist`, {appId})
    if(this.appManager.appHasTssKey(appId, seed))
      return true;
    const tssKey:JsonPublicKey|null = await this.appManager.queryAndLoadAppTssKey(appId, seed);
    return !!tssKey;
  }

  @ipcMethod(IpcMethods.FindNAvailablePartners)
  async __findNAvailablePartners(data: {appId: string, seed: string, searchList: string[], count: number}): Promise<string[]> {
    return await this.appManager.findNAvailablePartners(data.appId, data.seed, data.searchList, data.count)
  }

  @ipcMethod(IpcMethods.VerifyRequestSignature)
  async __verifyRequestSignature(request: AppRequest): Promise<boolean> {
    const {appId} = request
    const app: BaseAppPlugin = this.muon.getAppById(appId)
    if(!app)
      throw `app not found`
    return app.verifyRequestSignature(request);
  }
}

export default CoreIpcHandlers
