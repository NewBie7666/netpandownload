import { Router } from 'express'
import { ok } from '../http.js'
import { addVideoSource, importTvBoxSources, importTvBoxSourcesFromUrl, listVideoSources, removeVideoSource, updateVideoSource } from '../video-sources/store.js'
import { videoSourceProvider } from '../video-sources/provider.js'

export const videoSourcesRouter = Router()

function wrap(fn: (req: any) => Promise<unknown>) {
  return (req: any, res: any, next: any) => {
    Promise.resolve().then(() => fn(req)).then(result => res.json(ok(result))).catch(next)
  }
}

videoSourcesRouter.get('/sources', wrap(() => listVideoSources()))
videoSourcesRouter.post('/sources', wrap(req => addVideoSource(req.body)))
videoSourcesRouter.patch('/sources/:id', wrap(req => updateVideoSource(String(req.params.id), req.body)))
videoSourcesRouter.delete('/sources/:id', wrap(req => removeVideoSource(String(req.params.id))))
videoSourcesRouter.post('/import-tvbox', wrap(req => importTvBoxSources(req.body?.config)))
videoSourcesRouter.post('/import-tvbox-url', wrap(req => importTvBoxSourcesFromUrl(req.body?.url)))
videoSourcesRouter.get('/test', wrap(req => videoSourceProvider.test(req.query.sourceId)))
videoSourcesRouter.get('/search', wrap(req => videoSourceProvider.search(req.query.sourceId, req.query.keyword, req.query.page)))
videoSourcesRouter.get('/detail', wrap(req => videoSourceProvider.detail(req.query.sourceId, req.query.videoId)))
videoSourcesRouter.post('/download', wrap(req => videoSourceProvider.download(req.body)))
