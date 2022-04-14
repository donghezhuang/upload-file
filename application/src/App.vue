<template>
  <div class="container">
     <input type="file" @change="handleFileChange">
     <el-button type="primary" class="upload-btn" @click="handlerUpload">
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
            :percentage="Number(row.percentage)"
            color="#909399"
          ></el-progress>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script>
import Axios from 'axios'
import SparkMD5 from 'spark-md5'
// import Worker from './hash.worker.js'

const Status = {
  wait: "wait",
  pause: "pause",
  uploading: "uploading",
  error: "error",
  done: "done"
}
// CancelToken是一个构造函数，用于创建一个cancelToken实例对象
// cancelToken实例对象包含了一个promise属性，值为可以触发取消请求的一个promise
const CancelToken = Axios.CancelToken;
// 执行source()得到的是一个包含了cancelToken对象和一个取消函数cancel()的对象
let cancel;

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
      precent: 0, // 上传百分比
      uploadedChunkSize: 0, // 已完成上传的切片数
      fileInfo: null,
      chunkSize: 1* 1024 * 1024, // 切片大小
      dataList: [],
      fetchArr: [],
      cancelArr: [],
    }
  },
  methods: {
    // input改变事件监听
    handleFileChange(e) {
      const file = e.target.files[0]
      this.container.file = file
    },
    async handlerUpload() {
      let file = this.container.file
      if (!file) return

      this.status = Status.uploading;
      // 如果文件大小大于文件分片大小的5倍才使用分片上传
      if (file.size / this.chunkSize < 5) {
        this.sendFile(file)
        return
      }
      let { data } = await this.getUploadedFile(file.name) 
      console.log('dddd', data)

      if (data.data == 'fileExist') {
        this.isfileExist = true
        this.precent = 100
        this.status = Status.done
        return
      }
      this.createFileMd5(file).then(async fileMd5 => {
        // 先查询服务器是否已有上传完的文件切片
        let {data} = await this.getUploadedChunks(fileMd5)
        console.log(file)
        // if (data.data == 'FileAlreadyExists') {
        //   this.precent = 100
        //   this.status = Status.done
        //   this.$message({
        //     message: '文件上传成功',
        //     type: 'success'
        //   });
        //   return
        // }
        let uploaded = data.data.length ? data.data.map(v => v.split('-')[1] - 0) : []
        if (!uploaded.length ) localStorage.setItem(fileMd5, 0)
        // 切割文件
        const {remainChunks, uploadedChunks} = await this.cutBlob(fileMd5, file, uploaded)

        // 开始上传
        const chunks = uploadedChunks.concat(remainChunks)
        chunks.sort((a, b) => a.index - b.index)
        this.dataList = chunks.map(item => ({
            chunkName: item.name + '-' + item.index,
            size: item.chunk.size,
            percentage: uploaded.includes(item.index)? 100 : 0,
          })
        )
        this.sendRequest(remainChunks, 4, this.chunkMerge)
      })
    },
    
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
      const remainChunks = [] // 待上传切片
      const uploadedChunks = [] // 已上传切片
      const blobSlice = File.prototype.slice || File.prototype.mozSlice || File.prototype.webkitSlice
      const chunkNums = Math.ceil(file.size / this.chunkSize) // 切片总数

      return new Promise(resolve => {
        let startIndex = ''
        let endIndex = ''
        let contentItem = ''

        for(let i = 0; i < chunkNums; i++) {

          startIndex = i * this.chunkSize // 片段起点
          endIndex = (i + 1) * this.chunkSize // 片段尾点
          endIndex > file.size && (endIndex = file.size)
          // 切割文件
          contentItem = blobSlice.call(file, startIndex, endIndex)

          // 已上传
          if (uploaded.includes(i)) {
            uploadedChunks.push({
              index: i,
              chunk: contentItem,
              size: file.size,
              name: file.name
            })
          } else {
            remainChunks.push({
              index: i,
              chunk: contentItem,
              size: file.size,
              name: file.name
            })
          }
        }
        this.fileInfo = {
          hash: fileHash,
          total: chunkNums,
          name: file.name,
          size: file.size
        }
        resolve({remainChunks, uploadedChunks})
      })
    },
    // 请求并发处理
    sendRequest(arr, max = 6, callback) {
      this.fetchArr = []

      let toFetch = () => {
        
        if (!arr.length) {
          return Promise.resolve()
        }

        const chunkItem = arr.shift()
        const it = this.sendChunk(chunkItem)
        it.then(() => {
          // 成功从任务队列中移除
          this.fetchArr.splice(this.fetchArr.indexOf(it), 1)
        }, err => {
          if (Axios.isCancel(err)) {
            console.log("Rquest canceled", err.message); //请求如果被取消，这里是返回取消的message
          } else {
            this.status == Status.error
            // 如果失败则重新放入总队列中
            arr.unshift(chunkItem)
            console.log(err)
          }
        })
        this.fetchArr.push(it)
        console.log(this.fetchArr)
        let p = Promise.resolve()
        if (this.fetchArr.length >= max) {
          p = Promise.race(this.fetchArr)
        }
        return p.then(() => toFetch()) // 执行递归
      }

      toFetch().then(() => {
        Promise.all(this.fetchArr).then(() => {
          callback()
        })

      }, err => {
        console.log(err)
      })
    },
    // 请求已上传的文件
    getUploadedFile(name) {
      return this.$http({
        url: "/upload/checkFile",
        method: "post",
        data: { name }
      })
    },
    // 请求已上传文件切片
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

      let _this = this
      return this.$http({
        cancelToken: new CancelToken(function executor(c) {
          // executor 函数接收一个 cancel 函数作为参数
          cancel = c;
          _this.fetchArr.forEach(p => {
          _this.cancelArr.push({p, cancel})
          });
        }),
        url: "/upload/snippet",
        method: "post",
        data: formdata,
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: e => {
          const { loaded, total } = e
          this.dataList[item.index].percentage = ((loaded / total) *100).toFixed(2)
          this.uploadedChunkSize = Number(localStorage.getItem(this.fileInfo.hash))
          this.uploadedChunkSize += loaded
          this.uploadedChunkSize > item.size && (this.uploadedChunkSize = item.size)
          localStorage.setItem(this.fileInfo.hash, this.uploadedChunkSize)
          this.precent = ((this.uploadedChunkSize / item.size)* 100).toFixed(2) 
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
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (e) => {
          const { loaded, total } = e
          let uploadedFileSize = 0
          uploadedFileSize += loaded
          this.precent = ((uploadedFileSize / total) * 100).toFixed(2)
        }
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
      console.log(this.fetchArr);
      this.cancelArr.map( c=> {
        c.cancel()
      })
      this.status = Status.pause
    },
    async reupload() {
      this.status = Status.uploading
      // 开始上传
      this.handlerUpload()
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
  .upload-btn {
    margin-left: 20px !important;
  }
</style>
