import axios, { AxiosError, type AxiosInstance } from 'axios'
import crypto from 'node:crypto'
import QRCode from 'qrcode'
import { config } from '../config.js'
import { AppError } from '../http.js'
import type { QuarkAuthQrcodeResult, QuarkAuthStatusResult, QuarkFile } from '../../shared/types.js'

export interface QuarkShareData {
  shareId: string
  stoken: string
  files: QuarkFile[]
}

export interface QuarkListData {
  files: QuarkFile[]
}

export interface QuarkDownloadData {
  downloadUrl: string
  source: 'direct' | 'saved'
  expiresAt?: string
}

export interface ParsedShareUrl {
  shareId: string
  passcode: string
  dirFid?: string
}

export interface ShareFileListParams {
  shareId: string
  stoken: string
  dirFid?: string
}

interface QuarkApiResponse<T = unknown> {
  status?: number
  code?: number
  message?: string
  data?: T
}

interface QuarkTokenData {
  stoken?: string
}

type QuarkRawFile = Record<string, unknown>

interface QuarkDetailData {
  list?: QuarkRawFile[]
}

interface QuarkShareDownloadFile {
  download_url?: string
  downloadUrl?: string
  file_name?: string
  fid?: string
}

interface QuarkQrTokenData {
  members?: {
    token?: string
  }
}

interface QuarkQrTicketData {
  members?: {
    service_ticket?: string
  }
}

type QuarkShareDownloadData = QuarkShareDownloadFile[] | {
  list?: QuarkShareDownloadFile[]
  file?: QuarkShareDownloadFile
  download_url?: string
  downloadUrl?: string
}

interface QuarkTaskData {
  task_id?: string
  status?: number
  save_as?: Record<string, unknown>
}

interface QuarkPersonalFile {
  fid?: string
  file_name?: string
  name?: string
  size?: number
  dir?: boolean
}

interface QuarkPersonalFileListData {
  list?: QuarkPersonalFile[]
}

const defaultQuarkUa =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const shareFileTokenCache = new Map<string, string>()

interface QrLoginSession {
  id: string
  token: string
  qrLoginUrl: string
  cookie?: string
  status: QuarkAuthStatusResult['status']
  message: string
  expiresAt: number
}

const qrLoginSessions = new Map<string, QrLoginSession>()
const desktopDownloadUa =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch'

const mockFiles: Record<string, QuarkFile[]> = {
  root: [
    {
      fid: 'folder-100',
      name: '示例资料',
      size: 0,
      isDir: true,
      createdAt: '2026-06-08T09:00:00.000Z'
    },
    {
      fid: 'file-200',
      name: '演示视频.mp4',
      size: 734003200,
      isDir: false,
      createdAt: '2026-06-08T09:30:00.000Z'
    },
    {
      fid: 'file-201',
      name: '项目说明.pdf',
      size: 3145728,
      isDir: false,
      createdAt: '2026-06-08T10:00:00.000Z'
    }
  ],
  'folder-100': [
    {
      fid: 'file-300',
      name: '资料包.zip',
      size: 125829120,
      isDir: false,
      createdAt: '2026-06-08T10:30:00.000Z'
    },
    {
      fid: 'file-301',
      name: '截图.png',
      size: 524288,
      isDir: false,
      createdAt: '2026-06-08T10:45:00.000Z'
    }
  ]
}

export class QuarkApiAdapter {
  private readonly client: AxiosInstance

  constructor() {
    this.client = axios.create({
      timeout: 15000
    })
  }

  async createQrLoginSession(): Promise<QuarkAuthQrcodeResult> {
    try {
      const response = await this.client.get<QuarkApiResponse<QuarkQrTokenData>>(
        'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin',
        {
          headers: this.buildAuthHeaders(),
          params: {
            client_id: '532',
            v: '1.2',
            request_id: crypto.randomUUID()
          }
        }
      )

      const status = Number(response.data?.status)
      const token = String(response.data?.data?.members?.token || '').trim()
      if (status !== 2000000 || !token) {
        throw new AppError('quark_qr_token_failed', response.data?.message || '获取夸克登录二维码失败', 502)
      }

      const qrLoginUrl = this.buildQrLoginUrl(token)
      const qrImageUrl = await QRCode.toDataURL(qrLoginUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 260
      })
      const sessionId = crypto.randomUUID()
      const expiresAt = Date.now() + 5 * 60 * 1000
      qrLoginSessions.set(sessionId, {
        id: sessionId,
        token,
        qrLoginUrl,
        status: 'waiting',
        message: '等待扫码确认',
        expiresAt
      })

      return {
        sessionId,
        qrImageUrl,
        qrLoginUrl,
        expiresAt: new Date(expiresAt).toISOString()
      }
    } catch (error) {
      this.rethrowAxiosError(error)
      throw error
    }
  }

  async getQrLoginStatus(sessionId: string): Promise<QuarkAuthStatusResult> {
    const session = this.requireQrSession(sessionId)
    // QR polling may accumulate temporary cookies before the login session is
    // fully established. Only short-circuit once the session is actually logged in.
    if (session.status === 'logged_in' && session.cookie) {
      return this.toAuthStatusResult(session)
    }
    if (Date.now() > session.expiresAt) {
      session.status = 'expired'
      session.message = '二维码已过期，请重新获取'
      return this.toAuthStatusResult(session)
    }

    try {
      const response = await this.client.get<QuarkApiResponse<QuarkQrTicketData>>(
        'https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken',
        {
          headers: this.buildAuthHeaders(),
          params: {
            client_id: '532',
            v: '1.2',
            token: session.token,
            request_id: crypto.randomUUID()
          }
        }
      )
      const status = Number(response.data?.status)
      const serviceTicket = String(response.data?.data?.members?.service_ticket || '').trim()
      const responseCookie = this.extractResponseCookie(response.headers['set-cookie'])
      if (responseCookie) {
        session.cookie = this.mergeCookieStrings(session.cookie, responseCookie)
      }

      if (status === 2000000 && serviceTicket) {
        session.status = 'confirmed'
        session.message = '扫码已确认，正在建立登录会话'
        session.cookie = await this.exchangeServiceTicketForCookie(serviceTicket, session.cookie)
        session.cookie = await this.bootstrapLoginSessionCookie(session.cookie)
        session.status = 'logged_in'
        session.message = '已登录'
        session.expiresAt = Date.now() + 24 * 60 * 60 * 1000
        return this.toAuthStatusResult(session)
      }

      if ([50004002, 50004003, 50004004].includes(status)) {
        session.status = status === 50004004 ? 'expired' : 'failed'
        session.message = response.data?.message || '扫码登录失败，请重新获取二维码'
        return this.toAuthStatusResult(session)
      }

      session.status = 'waiting'
      session.message = '等待扫码确认'
      return this.toAuthStatusResult(session)
    } catch (error) {
      this.rethrowAxiosError(error)
      throw error
    }
  }

  clearQrLoginSession(sessionId: string) {
    qrLoginSessions.delete(String(sessionId || '').trim())
  }

  getSessionCookie(sessionId?: string) {
    if (!sessionId) return ''
    const session = qrLoginSessions.get(String(sessionId).trim())
    if (!session || session.status !== 'logged_in' || Date.now() > session.expiresAt) {
      return ''
    }
    return session.cookie || ''
  }

  parseShareUrl(shareUrl: string): ParsedShareUrl {
    const value = String(shareUrl || '').trim()
    if (!value) {
      throw new AppError('empty_share_url', '请输入夸克分享链接')
    }

    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new AppError('invalid_share_url', '分享链接格式不正确')
    }

    if (!/pan\.quark\.cn$/i.test(url.hostname)) {
      throw new AppError('unsupported_share_url', '仅支持夸克网盘分享链接')
    }

    const shareId = url.pathname.match(/\/s\/([^/?#]+)/)?.[1] || ''
    if (!shareId) {
      throw new AppError('invalid_share_url', '未识别到夸克分享 ID')
    }

    return {
      shareId,
      passcode: url.searchParams.get('pwd') || url.searchParams.get('passcode') || '',
      dirFid: url.hash.match(/\/list\/share\/([^/?#]+)/)?.[1]
    }
  }

  async getShare(shareId: string, passcode: string): Promise<QuarkShareData> {
    if (config.quarkMock) {
      return {
        shareId,
        stoken: `mock-stoken-${shareId}-${passcode || 'none'}`,
        files: mockFiles.root
      }
    }

    const stoken = await this.getShareToken(shareId, passcode)
    const detail = await this.getShareFileList({ shareId, stoken })
    return {
      shareId,
      stoken,
      files: detail.files
    }
  }

  async listFiles(
    shareId: string,
    stoken: string,
    dirFid?: string
  ): Promise<QuarkListData> {
    if (config.quarkMock) {
      return { files: mockFiles[dirFid || 'root'] || [] }
    }

    return this.getShareFileList({ shareId, stoken, dirFid })
  }

  async getShareToken(shareId: string, passcode = ''): Promise<string> {
    if (config.quarkMock) {
      return `mock-stoken-${shareId}-${passcode || 'none'}`
    }

    try {
      const response = await this.client.post<QuarkApiResponse<QuarkTokenData>>(
        'https://drive-h.quark.cn/1/clouddrive/share/sharepage/token',
        {
          pwd_id: shareId,
          passcode,
          support_visit_limit_private_share: true
        },
        {
          headers: this.buildHeaders(shareId),
          params: this.baseParams()
        }
      )

      this.assertQuarkOk(response.data, 'get_share_token')
      const stoken = String(response.data.data?.stoken || '').trim()
      if (!stoken) {
        throw new AppError('quark_unexpected_response', '夸克接口未返回分享凭证')
      }

      return stoken
    } catch (error) {
      this.rethrowAxiosError(error)
      throw error
    }
  }

  async getShareFileList(params: ShareFileListParams): Promise<QuarkListData> {
    if (config.quarkMock) {
      return { files: mockFiles[params.dirFid || 'root'] || [] }
    }

    const files: QuarkFile[] = []
    const pageSize = 50
    let page = 1

    try {
      while (true) {
        const response = await this.client.get<QuarkApiResponse<QuarkDetailData>>(
          'https://drive-h.quark.cn/1/clouddrive/share/sharepage/detail',
          {
            headers: this.buildHeaders(params.shareId),
            params: {
              ...this.baseParams(),
              pwd_id: params.shareId,
              stoken: params.stoken,
              pdir_fid: params.dirFid || '0',
              force: '0',
              _page: String(page),
              _size: String(pageSize),
              _sort: 'file_type:asc,updated_at:desc'
            }
          }
        )

        this.assertQuarkOk(response.data, 'get_share_detail')
        const rawList = response.data.data?.list
        if (!Array.isArray(rawList)) {
          throw new AppError('quark_unexpected_response', '夸克接口返回的文件列表格式异常')
        }

        files.push(...rawList.map((item) => this.mapFile(params.shareId, item)))

        if (rawList.length < pageSize) {
          break
        }
        page += 1
      }

      return { files }
    } catch (error) {
      this.rethrowAxiosError(error)
      throw error
    }
  }

  async getDownloadUrl(
    shareId: string,
    stoken: string,
    file: QuarkFile,
    sessionId?: string
  ): Promise<QuarkDownloadData> {
    if (config.quarkMock) {
      return {
        downloadUrl: `https://mock.local/quark/${encodeURIComponent(shareId)}/${encodeURIComponent(file.fid)}`,
        source: 'direct'
      }
    }

    const shareFidToken = shareFileTokenCache.get(this.cacheKey(shareId, file.fid))
    if (!shareFidToken) {
      throw new AppError('missing_share_file_token', '请重新获取文件列表后再获取下载链接')
    }

    const sessionCookie = this.getSessionCookie(sessionId) || config.quarkCookie

    try {
      const response = await this.client.post<QuarkApiResponse<QuarkShareDownloadData>>(
        'https://drive-m.quark.cn/1/clouddrive/file/share/download',
        {
          fids: [file.fid],
          pwd_id: shareId,
          stoken,
          fids_token: [shareFidToken]
        },
        {
          headers: this.buildHeaders(shareId, sessionCookie),
          params: {
            pr: 'ucpro',
            fr: 'h5',
            uc_param_str: '',
            __dt: String(Math.floor(Math.random() * 9800) + 200),
            __t: String(Date.now())
          }
        }
      )

      this.assertQuarkOk(response.data, 'get_share_download')
      const fileData = this.firstDownloadFile(response.data.data)
      const downloadUrl = String(fileData?.download_url || fileData?.downloadUrl || '').trim()
      if (!downloadUrl) {
        throw new AppError('quark_unexpected_response', '夸克接口未返回下载链接')
      }

      return { downloadUrl, source: 'direct' }
    } catch (error) {
      if (this.isDownloadLimitedError(error)) {
        if (!sessionCookie) {
          throw new AppError(
            'quark_download_limited',
            '大文件被夸克限制匿名下载，请先扫码登录后再获取链接'
          )
        }
        return this.getDownloadUrlViaSaveToDrive(shareId, stoken, file, shareFidToken, sessionCookie)
      }
      this.rethrowAxiosError(error)
      throw error
    }
  }

  private async getDownloadUrlViaSaveToDrive(
    shareId: string,
    stoken: string,
    file: QuarkFile,
    shareFidToken: string,
    sessionCookie: string
  ): Promise<QuarkDownloadData> {
    const taskId = await this.createShareSaveTask(shareId, stoken, file.fid, shareFidToken, sessionCookie)
    await this.waitTaskDone(taskId, sessionCookie)
    const savedFid = await this.findSavedPersonalFile(file, sessionCookie)
    const downloadUrl = await this.getPersonalFileDownloadUrl(savedFid, sessionCookie)
    return { downloadUrl, source: 'saved' }
  }

  private async createShareSaveTask(
    shareId: string,
    stoken: string,
    fid: string,
    shareFidToken: string,
    sessionCookie: string
  ) {
    const response = await this.client.post<QuarkApiResponse<QuarkTaskData>>(
      'https://drive.quark.cn/1/clouddrive/share/sharepage/save',
      {
        fid_list: [fid],
        fid_token_list: [shareFidToken],
        to_pdir_fid: '0',
        pwd_id: shareId,
        stoken,
        pdir_fid: '0',
        scene: 'link'
      },
      {
        headers: this.buildHeaders(shareId, sessionCookie),
        params: this.baseParams()
      }
    )
    this.assertQuarkOk(response.data, 'share_save')
    const taskId = String(response.data.data?.task_id || '').trim()
    if (!taskId) {
      throw new AppError('quark_save_task_missing', '夸克转存任务创建成功但未返回任务 ID', 502)
    }
    return taskId
  }

  private async waitTaskDone(taskId: string, sessionCookie: string) {
    for (let retryIndex = 0; retryIndex < 30; retryIndex += 1) {
      const response = await this.client.get<QuarkApiResponse<QuarkTaskData>>(
        'https://drive-pc.quark.cn/1/clouddrive/task',
        {
          headers: this.buildHeaders(undefined, sessionCookie),
          params: {
            ...this.baseParams(),
            task_id: taskId,
            retry_index: String(retryIndex)
          }
        }
      )
      this.assertQuarkOk(response.data, 'share_save_task')
      if (Number(response.data.data?.status) === 2) {
        return
      }
      await this.sleep(800)
    }
    throw new AppError('quark_save_task_timeout', '夸克转存任务未完成，请稍后重试', 504)
  }

  private async findSavedPersonalFile(file: QuarkFile, sessionCookie: string) {
    for (let page = 1; page <= 5; page += 1) {
      const response = await this.client.get<QuarkApiResponse<QuarkPersonalFileListData>>(
        'https://drive-pc.quark.cn/1/clouddrive/file/sort',
        {
          headers: this.buildHeaders(undefined, sessionCookie),
          params: {
            ...this.baseParams(),
            pdir_fid: '0',
            _page: String(page),
            _size: '100',
            _fetch_total: '1',
            _fetch_sub_dirs: '0',
            _sort: 'updated_at:desc'
          }
        }
      )
      this.assertQuarkOk(response.data, 'personal_file_sort')
      const list = response.data.data?.list || []
      const found = list.find((item) => {
        const name = String(item.file_name || item.name || '')
        return !item.dir && name === file.name && Number(item.size || 0) === Number(file.size || 0)
      })
      if (found?.fid) {
        return found.fid
      }
    }
    throw new AppError('quark_saved_file_missing', '文件已尝试转存，但未在网盘根目录找到对应文件', 502)
  }

  private async getPersonalFileDownloadUrl(fid: string, sessionCookie: string) {
    const response = await this.client.post<QuarkApiResponse<QuarkShareDownloadData>>(
      'https://drive-pc.quark.cn/1/clouddrive/file/download',
      {
        fids: [fid]
      },
      {
        headers: this.buildDesktopHeaders(sessionCookie),
        params: {
          pr: 'ucpro',
          fr: 'pc',
          sys: 'win32',
          ve: '2.5.56',
          ut: '',
          guid: ''
        }
      }
    )
    this.assertQuarkOk(response.data, 'personal_file_download')
    const fileData = this.firstDownloadFile(response.data.data)
    const downloadUrl = String(fileData?.download_url || fileData?.downloadUrl || '').trim()
    if (!downloadUrl) {
      throw new AppError('quark_unexpected_response', '夸克个人网盘接口未返回下载链接', 502)
    }
    return downloadUrl
  }

  private buildHeaders(shareId?: string, sessionCookie?: string) {
    const headers: Record<string, string> = {}
    headers['User-Agent'] = config.quarkUa || defaultQuarkUa
    headers.Accept = 'application/json, text/plain, */*'
    headers.Origin = 'https://pan.quark.cn'
    const cookie = sessionCookie || config.quarkCookie
    if (cookie) headers.Cookie = cookie
    if (config.quarkReferer) {
      headers.Referer = config.quarkReferer
    } else if (shareId) {
      headers.Referer = `https://pan.quark.cn/s/${shareId}`
    }
    headers['Content-Type'] = 'application/json'
    return headers
  }

  private buildAuthHeaders() {
    return {
      'User-Agent': config.quarkUa || defaultQuarkUa,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: 'https://pan.quark.cn',
      Referer: 'https://pan.quark.cn/',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    }
  }

  private buildDesktopHeaders(sessionCookie: string) {
    return {
      'User-Agent': desktopDownloadUa,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: 'https://pan.quark.cn',
      Referer: 'https://pan.quark.cn/',
      Cookie: sessionCookie
    }
  }

  private buildQrLoginUrl(token: string) {
    const params = new URLSearchParams({
      token,
      client_id: '532',
      ssb: 'weblogin',
      uc_param_str: '',
      uc_biz_str: 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0'
    })
    return `https://su.quark.cn/4_eMHBJ?${params.toString()}`
  }

  private async exchangeServiceTicketForCookie(serviceTicket: string, existingCookie = '') {
    const response = await this.client.get('https://pan.quark.cn/account/info', {
      headers: {
        ...this.buildAuthHeaders(),
        ...(existingCookie ? { Cookie: existingCookie } : {})
      },
      params: {
        st: serviceTicket,
        lw: 'scan'
      }
    })

    const cookie = this.mergeCookieStrings(
      existingCookie,
      this.extractResponseCookie(response.headers['set-cookie'])
    )
    if (!cookie) {
      throw new AppError('quark_cookie_missing', '夸克登录成功但未返回登录 Cookie，请重新扫码', 502)
    }
    return cookie
  }

  private async bootstrapLoginSessionCookie(existingCookie: string) {
    let cookie = existingCookie

    const mergeBootstrapCookie = (setCookieHeader: unknown) => {
      const nextCookie = this.extractResponseCookie(setCookieHeader)
      if (nextCookie) {
        cookie = this.mergeCookieStrings(cookie, nextCookie)
      }
    }

    const requests = [
      () =>
        this.client.get('https://pan.quark.cn/', {
          headers: {
            ...this.buildAuthHeaders(),
            ...(cookie ? { Cookie: cookie } : {})
          }
        }),
      () =>
        this.client.get('https://drive-pc.quark.cn/1/clouddrive/config', {
          headers: {
            ...this.buildDesktopHeaders(cookie)
          },
          params: this.baseParams()
        })
    ]

    for (const request of requests) {
      try {
        const response = await request()
        mergeBootstrapCookie(response.headers['set-cookie'])
      } catch {
        // Best-effort bootstrap. The initial login cookie is still usable for
        // listing and token APIs even if a follow-up cookie hydration step fails.
      }
    }

    return cookie
  }

  private requireQrSession(sessionId: string) {
    const session = qrLoginSessions.get(String(sessionId || '').trim())
    if (!session) {
      throw new AppError('quark_auth_session_missing', '登录会话不存在或已过期，请重新扫码登录')
    }
    return session
  }

  private extractResponseCookie(setCookieHeader: unknown) {
    if (!Array.isArray(setCookieHeader)) {
      return ''
    }
    return setCookieHeader.map((item) => String(item).split(';')[0]).filter(Boolean).join('; ')
  }

  private mergeCookieStrings(...cookieStrings: Array<string | undefined>) {
    const cookieMap = new Map<string, string>()
    for (const cookieString of cookieStrings) {
      const value = String(cookieString || '').trim()
      if (!value) continue
      for (const part of value.split(';')) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const separatorIndex = trimmed.indexOf('=')
        if (separatorIndex <= 0) continue
        const key = trimmed.slice(0, separatorIndex).trim()
        const cookieValue = trimmed.slice(separatorIndex + 1).trim()
        if (!key) continue
        cookieMap.set(key, cookieValue)
      }
    }
    return Array.from(cookieMap.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join('; ')
  }

  private toAuthStatusResult(session: QrLoginSession): QuarkAuthStatusResult {
    return {
      sessionId: session.id,
      status: session.status,
      message: session.message,
      expiresAt: new Date(session.expiresAt).toISOString()
    }
  }

  private baseParams() {
    return {
      pr: 'ucpro',
      fr: 'pc',
      uc_param_str: '',
      __dt: String(Math.floor(Math.random() * 9800) + 200),
      __t: String(Date.now())
    }
  }

  private assertQuarkOk(response: QuarkApiResponse, operation: string) {
    const code = Number(response?.code)
    const status = Number(response?.status)
    if (code === 0 && (!status || status === 200)) {
      return
    }

    throw this.toQuarkError(code, response?.message, operation)
  }

  private toQuarkError(code: number, message = '', operation = 'quark_request') {
    const readable = String(message || '').trim()
    if ([41004, 41006].includes(code)) {
      return new AppError('quark_share_unavailable', readable || '分享已失效或不存在')
    }
    if ([41008, 41009, 41010, 41017].includes(code)) {
      return new AppError('quark_passcode_invalid', readable || '提取码错误或分享需要提取码')
    }
    if ([401, 403, 50014, 50015].includes(code)) {
      return new AppError('quark_auth_failed', readable || '夸克鉴权或风控失败')
    }
    if (code === 23018) {
      return new AppError('quark_download_limited', '夸克限制了该文件的匿名下载，请稍后重试或配置服务端 Cookie')
    }
    return new AppError(
      'quark_api_error',
      readable || `夸克接口请求失败：${operation}${Number.isFinite(code) ? ` (${code})` : ''}`
    )
  }

  private isDownloadLimitedError(error: unknown) {
    if (error instanceof AppError) {
      return error.error === 'quark_download_limited'
    }
    if (error instanceof AxiosError) {
      const data = error.response?.data as QuarkApiResponse | undefined
      return Number(data?.code) === 23018
    }
    return false
  }

  private rethrowAxiosError(error: unknown): never | void {
    if (!(error instanceof AxiosError)) {
      return
    }

    const status = error.response?.status
    const data = error.response?.data as QuarkApiResponse | undefined
    if (data && typeof data === 'object' && 'code' in data) {
      throw this.toQuarkError(Number(data.code), data.message, 'quark_request')
    }
    if (status === 401 || status === 403) {
      throw new AppError('quark_auth_failed', '夸克鉴权或风控失败', 502)
    }
    if (error.code === 'ECONNABORTED') {
      throw new AppError('quark_timeout', '夸克接口请求超时', 504)
    }

    throw new AppError(
      'quark_network_error',
      status ? `夸克接口请求失败：HTTP ${status}` : '夸克接口网络请求失败',
      502
    )
  }

  private mapFile(shareId: string, raw: QuarkRawFile): QuarkFile {
    const fid = this.firstString(raw, ['fid', 'id'])
    const name = this.firstString(raw, ['file_name', 'name'])
    if (!fid || !name) {
      throw new AppError('quark_unexpected_response', '夸克文件数据缺少必要字段')
    }

    const shareFidToken = this.firstString(raw, ['share_fid_token', 'fid_token'])
    if (shareFidToken) {
      shareFileTokenCache.set(this.cacheKey(shareId, fid), shareFidToken)
    }

    return {
      fid,
      name,
      size: Number(raw.size || 0),
      isDir: Boolean(raw.dir),
      createdAt: this.toIsoTime(raw.created_at ?? raw.updated_at ?? raw.operated_at)
    }
  }

  private firstString(raw: QuarkRawFile, keys: string[]) {
    for (const key of keys) {
      const value = raw[key]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value)
      }
    }
    return ''
  }

  private firstDownloadFile(data: QuarkShareDownloadData | undefined) {
    if (!data) return undefined
    if (Array.isArray(data)) return data[0]
    if (Array.isArray(data.list)) return data.list[0]
    if (data.file) return data.file
    if (data.download_url || data.downloadUrl) return data
    return undefined
  }

  private cacheKey(shareId: string, fid: string) {
    return `${shareId}:${fid}`
  }

  private sleep(ms: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  private toIsoTime(value: unknown): string {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const timestamp = value > 10_000_000_000 ? value : value * 1000
      return new Date(timestamp).toISOString()
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) {
        return this.toIsoTime(numeric)
      }
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString()
      }
    }
    return ''
  }
}

export const quarkApi = new QuarkApiAdapter()
