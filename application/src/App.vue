<template>
  <div class="container">
     <input type="file" @change="handleFileChange">{{ precent }}%
     <el-button type="primary" @click="handlerUpload">
       上传<i class="el-icon-upload el-icon--right"></i>
      </el-button>
    <el-button round @click="reupload" v-if="status == Status.pause">恢复</el-button>
    <el-button
      round
      v-else
      :disabled="status !== Status.uploading"
      @click="stopUpload"
    >暂停</el-button>
    {{status}}
   
   <div class="total-percent">
      总进度
      <el-progress :text-inside="true" :stroke-width="20" :percentage="Number(precent)"></el-progress>
    </div>

    <el-table :data="dataList">
      <el-table-column
        prop="chunkName"
        label="切片hash"
        align="center"
      ></el-table-column>
      <el-table-column label="大小(KB)" align="center" width="120">
        <template v-slot="{ row }">
          {{ row.size | transformByte}}
        </template>
      </el-table-column>
      <el-table-column label="进度" align="center">
        <template v-slot="{ row }">
          <el-progress
            :percentage="row.percentage"
            color="#909399"
          ></el-progress>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script>
import SparkMD5 from 'spark-md5'
// import Worker from './hash.worker.js'

const Status = {
  wait: "wait",
  pause: "pause",
  uploading: "uploading",
  error: "error",
  done: "done"
}
export default {
  filters: {
    transformByte(val) {
      return Number((val / 1024).toFixed(0));
    }
  },
  data() {
    return {
      container: {
        file: null
      },
      Status,
      status: Status.wait, // 等待上传
      chunks: [], //所有切片
      remainChunks: [], // 剩余切片
      precent: 0, // 上传百分比
      uploadedChunkSize: 0, // 已完成上传的切片数
      fileInfo: null,
      chunkSize: 100 * 1024, // 切片大小
      dataList: []
    }
  },
  methods: {
    // input改变事件监听
    handleFileChange(e) {
      const file = e.target.files[0]
      this.container.file = file
    },
    handlerUpload() {
      let file = this.container.file
      if (!file) return

      this.status = Status.uploading;
      // 如果文件大小大于文件分片大小的5倍才使用分片上传
      if (file.size / this.chunkSize < 5) {
        this.sendFile(file)
        return
      }
      this.createFileMd5(file).then(async fileMd5 => {
        // 先查询服务器是否已有上传完的文件切片
        let {data} = await this.getUploadedChunks(fileMd5)
        let uploaded = data.data.length ? data.data.map(v => v.split('-')[1] - 0) : []
        console.log(uploaded)
        // 切割文件
        const chunkArr = await this.cutBlob(fileMd5, file, uploaded)
        this.remainChunks = chunkArr

        console.log(this.chunks)

        // 开始上传
        this.dataList = this.chunks.map(item => ({
          chunkName: item.name + '-' + item.index,
          size: item.chunk.size,
          percentage: 20,
        }))
        this.sendRequest(chunkArr, 4, this.chunkMerge)
      })
    },
    // createFileMd5(file) {
    //   return new Promise((resolve) => {
    //     const worker = new Worker()

    //     worker.postMessage({file, chunkSize: this.chunkSize})

    //     worker.onmessage = event => {
    //       resolve(event.data)
    //     }
    //   })
    // },
   
    createFileMd5(file) {
      return new Promise((resolve) => {
        const spark = new SparkMD5.ArrayBuffer()
        const reader = new FileReader()
        reader.readAsArrayBuffer(file)
        reader.addEventListener('loadend', ()=> {
          const content = reader.result

          // 生成文件hash
          spark.append(content)
          const hash = spark.end()
          console.log(hash) // 

          // 文件切割

          resolve(hash)
        })
      })
    },
    // 文件分割
    cutBlob(fileHash, file, uploaded) {
      const chunkArr = [] // 所有切片缓存数组
      const blobSlice = File.prototype.slice || File.prototype.mozSlice || File.prototype.webkitSlice
      const chunkNums = Math.ceil(file.size / this.chunkSize) // 切片总数

      return new Promise(resolve => {
        let startIndex = ''
        let endIndex = ''
        let contentItem = ''

        for(let i = 0; i < chunkNums; i++) {
          // 如果已上传则跳过
          if (uploaded.includes(i)) continue

          startIndex = i * this.chunkSize // 片段起点
          endIndex = (i + 1) * this.chunkSize // 片段尾点
          endIndex > file.size && (endIndex = file.size)

          // 切割文件
          contentItem = blobSlice.call(file, startIndex, endIndex)

          chunkArr.push({
            index: i,
            chunk: contentItem,
            size: file.size,
            name: file.name
          })
          console.log(2222)
        }
        this.fileInfo = {
          hash: fileHash,
          total: chunkNums,
          name: file.name,
          size: file.size
        }
        if (!uploaded.length) {
          console.log(111)
          this.chunks = chunkArr
        }
        resolve(chunkArr)
      })
    },
    // 请求并发处理
    sendRequest(arr, max = 6, callback) {
      let fetchArr = []

      let toFetch = () => {
        if (this.status == Status.pause) {
          return Promise.reject('暂停上传')
        }

        if (!arr.length) {
          return Promise.resolve()
        }

        const chunkItem = arr.shift()
        const it = this.sendChunk(chunkItem)
        it.then(() => {
          // 成功从任务队列中移除
          fetchArr.splice(fetchArr.indexOf(it), 1)
        }, err => {
          this.status == Status.error
          // 如果失败则重新放入总队列中
          arr.unshift(chunkItem)
          console.log(err)
        })
        fetchArr.push(it)
        console.log(it)

        let p = Promise.resolve()
        if (fetchArr.length >= max) {
          p = Promise.race(fetchArr)
        }
        return p.then(() => toFetch()) // 执行递归
      }

      toFetch().then(() => {
        Promise.all(fetchArr).then(() => {
          callback()
        })

      }, err => {
        console.log(err)
      })
    },
    // 请求已上传文件
    getUploadedChunks(hash) {
      return this.$http({
        url: "/upload/checkSnippet",
        method: "post",
        data: { hash }
      })
    },
    // 小文件上传
    sendChunk(item) {
      if (!item) return
      let formdata = new FormData()
      formdata.append("file", item.chunk)
      formdata.append("index", item.index)
      formdata.append("hash", this.fileInfo.hash)
      // formdata.append("name", this.fileInfo.name)

      return this.$http({
        url: "/upload/snippet",
        method: "post",
        data: formdata,
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (e) => {
          const { loaded } = e
          this.uploadedChunkSize += loaded
          this.uploadedChunkSize > item.size && (this.uploadedChunkSize = item.size)

          this.precent = ((this.uploadedChunkSize / item.size) * 100).toFixed(2)
        }
      })
    },
    // 文件上传方法
    sendFile(file) {
      let formdata = new FormData()
      formdata.append("file", file)

      this.$http({
        url: "/upload/file",
        method: "post",
        data: formdata,
        headers: { "Content-Type": "multipart/form-data" }
      }).then(({ data }) => {
        console.log(data, 'upload/file')
        this.status = Status.done
      })
    },
    // 请求合并
    chunkMerge() {
      this.$http({
        url: "/upload/merge",
        method: "post",
        data: this.fileInfo,
      }).then(res => {
        console.log(res.data)
        this.status = Status.done
      })
    },
    stopUpload() {
      this.status = Status.pause
    },
    reupload() {
      this.status = Status.uploading
      // 开始上传
      this.sendRequest(this.remainChunks, 4, this.chunkMerge)
    }
  }
}
</script>

<style>
  .container {
    padding: 20px;
  }
  .total-percent {
    margin-top: 20px;
  }
</style>
