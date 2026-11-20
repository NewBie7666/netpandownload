// Own validation rule against the live NASA API. This is not a community TVBox source.
function json(url) {
  const value = req(url)
  return JSON.parse(typeof value === 'string' ? value : value.content)
}
function list(query) {
  return json('https://images-api.nasa.gov/search?media_type=video&page_size=1&' + query).collection.items.map(item => ({
    vod_id: item.data[0].nasa_id,
    vod_name: item.data[0].title,
    vod_content: item.data[0].description || ''
  }))
}
export default {
  home() { return { class: [], list: [] } },
  search(word) { return { page: 1, pagecount: 1, list: list('q=' + encodeURIComponent(word)) } },
  detail(id) {
    return { list: list('nasa_id=' + encodeURIComponent(id)).map(item => ({
      ...item, vod_play_from: 'NASA', vod_play_url: 'Preview$' + item.vod_id
    })) }
  },
  play(flag, id) {
    const items = json('https://images-api.nasa.gov/asset/' + encodeURIComponent(id)).collection.items
    const media = items.find(item => /~preview\.mp4$/.test(item.href))
    if (!media) throw Error('NASA asset has no preview MP4')
    return { parse: 0, url: media.href.replace(/^http:/, 'https:'), header: { 'User-Agent': 'NetPanDownload-Type3-QA' } }
  }
}
