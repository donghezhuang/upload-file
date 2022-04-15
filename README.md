# 前端大文件上传 + 断点续传 + 暂停/继续上传 + 秒传解决方案

重新演示上传需要删除 /public/uploads 中的文件，否则由于服务端保存了文件上传会直接成功


前端
* vue + element 界面展示
* Blob#slice 实现文件切片
* FileReader + spark-md5 生成文件 hash
* axios 发送 formData

服务端
* nodejs
* koaBody 处理 formData

# start

```
npm install
```

```
npm run serve
```
