
# JLC's DALL·E 3 Archiver

I previously made an [archiver for Midjourney](https://github.com/JoakimCh/jlc-midjourney-archiver), but I also needed one for DALL·E 3. Hence this project was born!

Since I currently only use DALL·E 3 through [ChatGPT](https://chat.openai.com) it only supports this use case (at least for now).

How it works is that it will intercept the communication between the browser (which MUST be [Chromium based](https://www.google.com/search?q=chromium+based+browsers)) and the ChatGPT website to fetch the images and the related details.

For now it doesn't automatically crawl through their website to fetch previously generated images, but it will fetch them if you manually load those conversations and browse through them.

And it will fetch any new images you generate while the archiver is running!

## The archived details:

It stores records with additional details for each image, for now they are:
| Field | Description |
| --- | --- |
| gen_id | The unique ID of the image. |
| prompt | The prompt used. |
| seed | The seed used. |
| date | The unix timestamp (also known as [epoch time](https://en.wikipedia.org/wiki/Epoch_(computing))). |
| fileId | Also a unique ID (used to fetch the image file). |
| width | Width in pixels. |
| height | Height in pixels. |

> Where the same prompt and seed can be used to recreate an exact copy of the image (if used with the same DALL·E version).

## How to run it?

You can run it using the [Node.js](https://nodejs.org/) package manager ([NPM](https://www.npmjs.com/)). To install NPM you'll have to install Node.js if you haven't done so already.

Then you should be able to run the archiver (in the current working directory) by typing:
```sh
npx dalle-archiver
```
Which will try to setup the archive in the directory where you ran the command, if no "config.json" file was there already it will first create one and exit.

The "config.json" file it created looks something like this:
```json
{
  "chromiumPath": "google-chrome",
  "archivePath": "the/absolute/path/to/the/directory"
}
```
On my Linux system "google-chrome" is the command which will launch my compatible browser. If you use macOS or Windows it will try to detect the path to Chrome. But please check that it got it right or manually enter the path  to a Chromium based browser.

I suspect these values will work (if you use Chrome):
| System | Path |
| --- | --- |
| macOS | ~/Library/Application Support/Google/Chrome |
| Windows | C:\Program Files\Google\Chrome\Application\chrome.exe

### Why must it be Chromium based?

This is because my archiver is using the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) to do its magic. This allows my program to interact with the OpenAI APIs (and intercept communication) without them being able to use naughty tricks to block it.

> Since it's pretty much hopeless today to write a program that perfectly emulates a browser this is just how I have to do it...

## What's the structure of the archive?

In the archive directory two directories will be created, which are named "database" and "images".

### The images directory:

The "images" directory is where every image will be downloaded to. And they will be archived in subdirectories matching the creation date of the image.

The filenames will be formatted like this: 
```
unix_time-gen_id-beginning_of_prompt.webp
```

So a full path to an image could look like this:
```
archive_dir/2023/11/06/1698615680-M5QoHjYO7Qe9pl1Z-Photo-of-a-man….webp
```

Any truncated prompt is followed by … ([U+2026](https://en.wikipedia.org/wiki/Ellipsis)) to make it clear that it was truncated. This is done to avoid file-system errors due to too long filenames.

### The database directory:

The "database" directory is where records are kept for every image which has been archived. This system allows you to delete or rename the downloaded images while still keeping a record to avoid them being re-downloaded.

Also [more details](#the-archived-details) about the images are stored in those records!

Looking up details for a specific image in the database is very easy to do using the search function in your file explorer. Just copy the "gen_id" part of the image and search the database directory for the record (which is a .json file).

These records also store the "fileId" in their filename just after the "gen_id", so they typically look like this:
```
DneOERrWVpnXPZVc-mTlImgNhbMGexJI3DFLJXJlh.json
```

## Why [WebP](https://en.wikipedia.org/wiki/WebP) image format?!

Because this is what DALL·E 3 is natively using when serving you the generated images. Even the PNG image they allow you to download through their interface is just a WebP image converted to a PNG image with a much larger file size (which doesn't make much sense to do).

The archived WebP images are the original quality and untouched by my software! 😎

> In theory [AVIF](https://en.wikipedia.org/wiki/AVIF) is a better format though (allows smaller file size), but it has less software support. Feel free to convert them into that format if you're low on storage space.

## How do I support you?

I am at the moment chronically sick, without a job, with tons of debt, two kids and a wife (which I can't support economically). So please [sponsor my efforts](https://github.com/sponsors/JoakimCh) to develop and maintain a working solution like this, I would really appreciate it if you did! ❤️

## The end, of the readme that is...

If you want to get in touch you can find me on Twitter/X as [JLC_AI](https://twitter.com/JLC_AI).

> Please wake up, please realize that you're God roleplaying as a human!
