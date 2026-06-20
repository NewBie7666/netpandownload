<script setup lang="ts">
import { computed, ref } from 'vue'
import { parseLink } from './api'
import { decisionEngine, toDecisionViewModel } from './decision'
import type { DecisionViewModel } from './decision'
import type { WebParseResult } from '../server/types'

const input = ref('')
const passcode = ref('')
const parsedUrl = ref('')
const loading = ref(false)
const error = ref('')
const notice = ref('')
const result = ref<WebParseResult | null>(null)

const decisionView = computed<DecisionViewModel | null>(() => {
  if (!result.value) return null
  return toDecisionViewModel(decisionEngine(result.value), parsedUrl.value)
})

async function copyText(text: string, successMessage: string) {
  if (!text) return
  await navigator.clipboard.writeText(text)
  notice.value = successMessage
}

function openDesktopApp() {
  if (!parsedUrl.value) return
  window.location.href = `netpan://action?type=download&url=${encodeURIComponent(parsedUrl.value)}`
}

async function submit() {
  error.value = ''
  notice.value = ''
  result.value = null
  parsedUrl.value = input.value.trim()
  loading.value = true
  try {
    result.value = await parseLink(input.value, passcode.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '解析失败，请稍后重试'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="page">
    <section class="hero">
      <div>
        <p class="eyebrow">NetPan Parser Web</p>
        <h1>在线解析版</h1>
        <p class="summary">只解析链接和列表信息，不在公网执行下载、不生成 B站临时媒体直链。</p>
      </div>
      <span class="mode-badge">PURE PARSER</span>
    </section>

    <section class="panel">
      <label class="field">
        <span>资源链接</span>
        <input v-model="input" placeholder="粘贴夸克分享链接、B站 BV / 合集 / 空间搜索链接" @keyup.enter="submit" />
      </label>
      <label class="field">
        <span>提取码</span>
        <input v-model="passcode" placeholder="夸克链接可填；B站链接无需填写" @keyup.enter="submit" />
      </label>
      <button class="primary" :disabled="loading || !input.trim()" @click="submit">
        {{ loading ? '解析中...' : '解析资源' }}
      </button>
    </section>

    <p v-if="error" class="message error">{{ error }}</p>
    <p v-if="notice" class="message success">{{ notice }}</p>

    <section v-if="result && decisionView" class="panel decision-panel">
      <div class="decision-header">
        <div>
          <p class="eyebrow">{{ decisionView.platformLabel }}</p>
          <h2>{{ result.title || '解析结果' }}</h2>
        </div>
        <span class="count">{{ result.files.length }} 项</span>
      </div>

      <div class="decision-summary">
        <div class="decision-conclusion" :class="`status-${decisionView.status}`">
          <span>{{ decisionView.statusText }}</span>
          <strong>成功率 {{ decisionView.successPercent }}%</strong>
        </div>
        <div class="success-meter" aria-label="成功率">
          <span :style="{ width: `${decisionView.successPercent}%` }"></span>
        </div>
        <p>{{ decisionView.humanMessage }}</p>
      </div>

      <div class="decision-grid">
        <article>
          <span>风险等级</span>
          <strong :class="`risk-${decisionView.risk}`">{{ decisionView.riskText }}</strong>
        </article>
        <article>
          <span>推荐工具</span>
          <strong>{{ decisionView.toolLabels }}</strong>
        </article>
        <article>
          <span>置信度</span>
          <strong>{{ decisionView.successPercent }}%</strong>
        </article>
      </div>

      <div class="reason-tags">
        <span v-for="tag in decisionView.reasonTags" :key="tag">{{ tag }}</span>
      </div>

      <div class="action-panel">
        <div>
          <h3>推荐操作</h3>
          <ol>
            <li v-for="step in decisionView.actionSteps" :key="step">{{ step }}</li>
          </ol>
        </div>
        <div class="action-buttons">
          <button v-if="decisionView.actions.copyUrl" class="secondary" type="button" @click="copyText(parsedUrl, '链接已复制')">
            复制链接
          </button>
          <button v-if="decisionView.actions.openDesktop" class="secondary" type="button" @click="openDesktopApp">
            打开桌面端
          </button>
          <button
            v-if="decisionView.actions.copyCommand"
            class="secondary"
            type="button"
            @click="copyText(decisionView.actions.copyCommand, '命令已复制')"
          >
            复制命令
          </button>
        </div>
      </div>

      <div v-if="result.warnings.length" class="warnings">
        <p v-for="warning in result.warnings" :key="warning">{{ warning }}</p>
      </div>

      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>类型</th>
            <th>状态</th>
            <th>提示</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="file in result.files" :key="file.id">
            <td>{{ file.name }}</td>
            <td>{{ file.type }}</td>
            <td><span class="status">{{ file.status }}</span></td>
            <td>{{ file.hint }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </main>
</template>
