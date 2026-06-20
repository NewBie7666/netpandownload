<script setup lang="ts">
import { computed, ref } from 'vue'
import { parseLink } from './api'
import { buildDecisionView, executeOpaqueAction } from './decision'
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
  return buildDecisionView(result.value)
})

async function copyText(text: string, successMessage: string) {
  if (!text) return
  await navigator.clipboard.writeText(text)
  notice.value = successMessage
}

function runOpaqueAction(actionToken: DecisionViewModel['buttons'][number]['actionToken']) {
  void executeOpaqueAction(actionToken, {
    url: parsedUrl.value,
    copyText,
    openUrl(value) {
      window.location.href = value
    }
  })
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
        <p class="summary">只解析链接和列表信息，不在公网执行下载，不生成临时媒体直链。</p>
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
          <p class="eyebrow">{{ decisionView.textBlocks[0]?.text }}</p>
          <h2>{{ decisionView.textBlocks[1]?.text }}</h2>
        </div>
        <span class="count">{{ result.files.length }} 项</span>
      </div>

      <div class="decision-summary">
        <div class="decision-conclusion">
          <span v-for="badge in decisionView.badges" :key="badge.text" :class="`badge-${badge.tone}`">{{ badge.text }}</span>
          <strong v-for="token in decisionView.visualTokens" :key="`${token.shape}:${token.token}`">{{ token.token }}</strong>
        </div>
        <p v-for="block in decisionView.textBlocks.slice(2)" :key="`${block.role}:${block.text}`">{{ block.text }}</p>
      </div>

      <div class="decision-grid">
        <article v-for="section in decisionView.sections" :key="section.title">
          <span>{{ section.title }}</span>
          <ul>
            <li v-for="item in section.items" :key="item">{{ item }}</li>
          </ul>
        </article>
      </div>

      <div class="action-panel" v-if="decisionView.buttons.length">
        <div>
          <h3>可用操作</h3>
          <p>按钮只执行展示层操作，不改变解析或下载流程。</p>
        </div>
        <div class="action-buttons">
          <button
            v-for="button in decisionView.buttons"
            :key="button.actionToken"
            :class="button.variant === 'primary' ? 'primary' : 'secondary'"
            type="button"
            @click="runOpaqueAction(button.actionToken)"
          >
            {{ button.label }}
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
            <th>提示</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="file in result.files" :key="file.id">
            <td>{{ file.name }}</td>
            <td>{{ file.type }}</td>
            <td>{{ file.hint }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </main>
</template>
