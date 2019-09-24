const { slugify } = require('./src/utils/helpers')
import fs from 'fs'
import urlRegex from 'url-regex'
import Amplify, { Storage } from 'aws-amplify'
import config from './src/aws-exports.js'
import getImageKey from './src/utils/getImageKey'
import getRawPath from './src/utils/getRawPath'
import downloadImage from './src/utils/downloadImage'

const axios = require('axios')
const graphqltag = require('graphql-tag')
const gql = require('graphql')
const { print } = gql

Amplify.configure(config)

const {
  aws_user_files_s3_bucket: bucket
} = config

exports.createPages = async ({ graphql, actions }) => {
  const { createPage } = actions

  const blogPost = require.resolve(`./src/templates/blog-post.js`)
  const postData = await graphql(`
  {
    appsync {
      listPosts {
        items {
          content
          createdAt
          description
          id
          published
          title
          cover_image
        }
      }
    }
  }
  `)

  const blogPosts = postData.data.appsync.listPosts.items.filter(post => post.published)
  await Promise.all(
    blogPosts.map(async(post, index) => {
      if (!post) return
      if (!fs.existsSync(`${__dirname}/public/downloads`)){
        fs.mkdirSync(`${__dirname}/public/downloads`);
      }
      const content = post.content
      const contentUrls = content.match(urlRegex());
      let images = []
      if (contentUrls) {
        contentUrls.forEach(url => {
          if(url.includes(bucket)) {
            const key = getImageKey(url)
            const cleanedKey = key.replace(/[{()}]/g, '');
            const keyWithPath = `images/${cleanedKey}`
            const image = Storage.get(keyWithPath)
            images.push(image)
          }
        })
      }

      const signedUrls = await Promise.all(images)
      let urlIndex = 0
      const pathsToDownload = []
      const rawPaths = []
  
      // create array of raw local image URLs (rawPaths)
      // we use these raw paths locally to reference the downloaded images.
      signedUrls.forEach(url => rawPaths.push(`${getRawPath(url)})`))
      // create array of images with signed paths so we can download them in the next step
      signedUrls.forEach(signedUrl => pathsToDownload.push(downloadImage(signedUrl)))

      // download cover image
      let coverImage
      if (post.cover_image) {
        pathsToDownload.push(downloadImage(post.cover_image))
        coverImage = getImageKey(post.cover_image)
        coverImage = `../downloads/${coverImage}`
      }

      if (pathsToDownload.length) {
        // if there are any images, we download them to the local file system
        await Promise.all(pathsToDownload)
      }
  
      let updatedContent = content.replace(urlRegex({strict: false}), (url) => {
        if(url.includes(bucket)) {
          const chosenUrl = rawPaths[urlIndex]
          const split = chosenUrl.split('/')
          const relativeUrl = `../downloads/${split[split.length - 1]}`
          urlIndex++
          return relativeUrl
        } else {
          return url
        }
      })
      post['content'] = updatedContent
      
      const previous = index === blogPosts.length - 1 ? null : blogPosts[index + 1].node
      const next = index === 0 ? null : blogPosts[index - 1]
  
      createPage({
        path: slugify(post.title),
        component: blogPost,
        context: {
          id: post.id,
          content: post.content,
          title: post.title,
          published: post.published,
          createdAt: post.createdAt,
          cover_image: post.cover_image,
          local_cover_image: coverImage,
          description: post.description,
          slug: slugify(post.title),
          type: "appsyncData",
          previous,
          next,
        },
      })
    })
  )
}

exports.onCreatePage = async ({ page, actions }) => {
  const { createPage } = actions
  if (page.path.match(/^\/editpost/)) {
    page.matchPath = '/editpost/*'
    createPage(page)
  }
  if (page.path.match(/^\/previewpost/)) {
    page.matchPath = '/previewpost/*'
    createPage(page)
  }
}

exports.sourceNodes = async ({ graphql, actions, createNodeId, createContentDigest }) => {
  const { createNode } = actions
  const imageKeys = []

  const query = graphqltag(`
    query listPosts {
      listPosts(limit: 500) {
        items {
          content
          createdAt
          description
          id
          published
          title
          cover_image
        }
      }
    }
  `)
  
  try {
    const graphqlData = await axios({
      url: config.aws_appsync_graphqlEndpoint,
      method: 'post',
      headers: {
        'x-api-key': config.aws_appsync_apiKey
      },
      data: {
        query: print(query)
      }
    })
    const blogPosts = graphqlData.data.data.listPosts.items
    blogPosts.map(post => {
      const content = post.content
      const contentUrls = content.match(urlRegex());
      if (contentUrls) {
        contentUrls.forEach(url => {
          if(url.includes(bucket)) {
            const key = getImageKey(url)
            const cleanedKey = key.replace(/[{()}]/g, '');
            const keyWithPath = `images/${cleanedKey}`
            imageKeys.push(keyWithPath)
          }
        })
      }
      if (post.cover_image) {
        const key = getImageKey(post.cover_image)
        const cleanedKey = key.replace(/[{()}]/g, '');
        const keyWithPath = `images/${cleanedKey}`
        imageKeys.push(keyWithPath)
      }

    })
      
    const data = {
      key: 'image-keys',
      data: imageKeys
    }
    const nodeContent = JSON.stringify(data)
    const nodeMeta = {
      id: createNodeId(`my-data-${data.key}`),
      parent: null,
      children: [],
      internal: {
        type: `ImageKeys`,
        mediaType: `text/html`,
        content: nodeContent,
        contentDigest: createContentDigest(data)
      }
    }
    const node = Object.assign({}, data, nodeMeta)
    createNode(node)
  } catch(error) {
    console.log('error creating image keys.. :', error)
  }
}