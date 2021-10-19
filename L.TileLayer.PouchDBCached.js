/**
 * Taken from https://github.com/MazeMap/Leaflet.TileLayer.PouchDBCached/blob/master/L.TileLayer.PouchDBCached.js
 * and modified here for rapid development ...
 * todo: push fixes to the community
 * changelog
 * - added compatibility with Leaflet.ContinuousZoom.js
 * - added errorTileUrl eviction so that previously failed tiles which had their error tile cached will be evicted when online
 * - added error seed status and tests seed debugging layer.
 * - improved seed event data (so you can hook into the seed drawing data and do it yourself if you wanted)
 * - added useful tileToFeature()
 * - added getStoredTilesAsGeojson() function
 * - added showStoredTiles() function
 * - some jank seedWorker code not working
 *
 * todo: change all docs to jsdocs
 * todo: change function(){}.bind(this) to arrow functions I think they should work the same someone pls confirm
 */


// HTMLCanvasElement.toBlob() polyfill
// copy-pasted off https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob
// import {Bounds} from "leaflet/src/geometry/Bounds";

if (!HTMLCanvasElement.prototype.toBlob) {
	Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
		value: function (callback, type, quality) {
			var dataURL = this.toDataURL(type, quality).split(",")[1];
			setTimeout(function () {
				var binStr = atob(dataURL),
					len = binStr.length,
					arr = new Uint8Array(len);

				for (var i = 0; i < len; i++) {
					arr[i] = binStr.charCodeAt(i);
				}

				callback(new Blob([arr], {type: type || "image/png"}));
			});
		},
	});
}

L.TileLayer.addInitHook(function () {
	if (!this.options.useCache) {
		this._db = null;
		return;
	}

	this._db = new PouchDB("offline-tiles");

	this._lookupErrorImg();

});

// 🍂namespace TileLayer
// 🍂section PouchDB tile caching options
// 🍂option useCache: Boolean = false
// Whether to use a PouchDB cache on this tile layer, or not
L.TileLayer.prototype.options.useCache = false;

// 🍂option saveToCache: Boolean = true
// When caching is enabled, whether to save new tiles to the cache or not
L.TileLayer.prototype.options.saveToCache = true;

// 🍂option useOnlyCache: Boolean = false
// When caching is enabled, whether to request new tiles from the network or not
L.TileLayer.prototype.options.useOnlyCache = false;

// 🍂option cacheFormat: String = 'image/png'
// The image format to be used when saving the tile images in the cache
L.TileLayer.prototype.options.cacheFormat = "image/png";

// 🍂option cacheMaxAge: Number = 24*3600*1000
// Maximum age of the cache, in milliseconds
L.TileLayer.prototype.options.cacheMaxAge = 7 * 24 * 3600 * 1000;

L.TileLayer.include({
	// Overwrites L.TileLayer.prototype.createTile
	createTile: function (coords, done) {
		var tile = document.createElement("img");

		tile.onerror = L.bind(this._tileOnError, this, done, tile);

		if (this.options.crossOrigin) {
			tile.crossOrigin = "";
		}

		/*
         Alt tag is *set to empty string to keep screen readers from reading URL and for compliance reasons
         http://www.w3.org/TR/WCAG20-TECHS/H67
         */
		tile.alt = "";

		var tileUrl = this.getTileUrl(coords);

		if (this.options.useCache) {
			this._db.get(
				tileUrl,
				{revs_info: true},
				this._onCacheLookup(tile, tileUrl, done)
			);
		} else {
			// Fall back to standard behaviour
			tile.onload = L.bind(this._tileOnLoad, this, done, tile);
			tile.src = tileUrl;
		}

		return tile;
	},

	// Returns a callback (closure over tile/key/originalSrc) to be run when the DB
	//   backend is finished with a fetch operation.
	_onCacheLookup: function (tile, tileUrl, done) {
		return function (err, data) {
			if (data) {
				return this._onCacheHit(tile, tileUrl, data, done);
			} else {
				return this._onCacheMiss(tile, tileUrl, done);
			}
		}.bind(this);
	},

	_onCacheHit: function (tile, tileUrl, data, done) {
		this.fire("tilecachehit", {
			tile: tile,
			url: tileUrl,
		});

		// Read the attachment as blob
		this._db.getAttachment(tileUrl, "tile").then(
			function (blob) {
				var url = URL.createObjectURL(blob);

				if ((Date.now() > data.timestamp + this.options.cacheMaxAge
					|| (data._attachments.tile.digest === this._errorDigest))//if expired or and error is cached and
					&& !this.options.useOnlyCache && navigator.onLine //we have to be online  and not forced to use cache
				) {
					// Tile is too old or the error tile is cached and were online, try to refresh it
					console.log("Tile is too old: ", tileUrl);
					//todo detect tile not found tiles chacned and retry
					if (this.options.saveToCache) {
						tile.onload = L.bind(
							this._saveTile,
							this,
							tile,
							tileUrl,
							data._revs_info[0].rev,
							done
						);
					}
					tile.crossOrigin = "Anonymous";
					tile.src = tileUrl;
					tile.onerror = function (ev) {
						// If the tile is too old but couldn't be fetched from the network,
						//   serve the one still in cache.
						this.src = url;
					};
				} else {
					// Serve tile from cached data
					//console.log('Tile is cached: ', tileUrl);
					tile.onload = L.bind(this._tileOnLoad, this, done, tile);
					tile.src = url;
				}
			}.bind(this)
		);
	},

	_onCacheMiss: function (tile, tileUrl, done) {
		this.fire("tilecachemiss", {
			tile: tile,
			url: tileUrl,
		});
		if (this.options.useOnlyCache) {
			// Offline, not cached
			// 	console.log('Tile not in cache', tileUrl);
			tile.onload = L.Util.falseFn;
			tile.src = L.Util.emptyImageUrl;
		} else {
			// Online, not cached, request the tile normally
			// console.log('Requesting tile normally', tileUrl);
			if (this.options.saveToCache) {
				tile.onload = L.bind(
					this._saveTile,
					this,
					tile,
					tileUrl,
					undefined,
					done
				);
			} else {
				tile.onload = L.bind(this._tileOnLoad, this, done, tile);
			}
			tile.crossOrigin = "Anonymous";
			tile.src = tileUrl;
		}
	},


	/**
	 * This is used to lookup the error tile so that we can check on cache hit if we have an error tile cached
	 * @private
	 */
	_lookupErrorImg: async function () {

		var tile = this._createTile();
		let url = this.options.errorTileUrl;
		let rev = undefined;
		try {
			let r = await bl.openStreetMap._db.get(url);
			if (r) {
				rev = r._rev;
			}
		} catch (e) {
			//do nothing leave rev undefined
			console.warn("No Error Tile In Cache");
		}


		tile.onload = function (ev) {
			console.warn("Got Error Tile");
			this._saveTile(tile, url, rev, () => {
				console.warn("Saved " + url + " to pouch db");
				this._db.get(url).then(r => {
					console.log(r);
					if (r._attachments && r._attachments.tile && r._attachments.tile.digest) {
						this._errorDigest = r._attachments.tile.digest
						console.warn("Found Error Digest: ", this._errorDigest);

					} else {
						console.warn("Looked up error tile but there was not attachment")
					}
				})
			}); //(ev)
		}.bind(this);
		tile.onerror = function (ev) {

			console.warn("Failed to load error tile");
		}.bind(this);

		tile.src = url;


// md5-L1b+BOFwivtujzQkVl4x/g==
//         this._saveTile(tile, this.options.errorTileUrl, undefined, () => {
//         });
	},

	/**
	 * Async'ly saves the tile as a PouchDB attachment
	 * Will run the done() callback (if any) when finished.
	 * @param tile - img element from _createTile
	 * @param tileUrl - the url
	 * @param existingRevision - the existing revision of a file from _db.get
	 * @param done - a callback
	 * @private
	 */
	_saveTile: function (tile, tileUrl, existingRevision, done) {
		if (!this.options.saveToCache) {
			return;
		}

		var canvas = document.createElement("canvas");
		canvas.width = tile.naturalWidth || tile.width;
		canvas.height = tile.naturalHeight || tile.height;

		var context = canvas.getContext("2d");
		context.drawImage(tile, 0, 0);

		var format = this.options.cacheFormat;

		canvas.toBlob(
			function (blob) {
				this._db
					.put({
						_id: tileUrl,
						_rev: existingRevision,
						timestamp: Date.now(),
					})
					.then(
						function (status) {
							return this._db.putAttachment(
								tileUrl,
								"tile",
								status.rev,
								blob,
								format
							);
						}.bind(this)
					)
					.then(function (resp) {
						if (done) {
							done();
						}
					})
					.catch(function (e) {
						// Saving the tile to the cache might have failed,
						// but the tile itself has been loaded.
						console.log("Failed to save", e);
						if (done) {
							done();
						}
					});
			}.bind(this),
			format
		);
	},

	// 🍂section PouchDB tile caching methods
	// 🍂method seed(bbox: LatLngBounds, minZoom: Number, maxZoom: Number, zooms: Array<Number>): this
	// Starts seeding the cache given a bounding box and the minimum/maximum zoom levels
	// if zooms is present then each zoom in the array is seeded
	// Use with care! This can spawn thousands of requests and flood tileservers!
	seed: function (bbox, minZoom, maxZoom, zooms, animate = true, prompts = false) {
		if (!this.options.useCache) return;
		if (minZoom > maxZoom) return;
		if (!this._map) return;


		if (!Array.isArray(zooms)) {
			zooms = []
			for (var z = minZoom; z <= maxZoom; z++) {
				zooms.push(z);
			}
		}

		minZoom = Math.min(zooms)


		if (this._seedLayer) {
			this._seedLayer.remove();
		}
		let urls
		if (animate) {
			let ts = this.testSeed(bbox, zooms);
			urls = ts.urls;
			this._seedLayer = ts.layer;
		} else {
			urls = this._getSeedUrls(bbox, zooms)
			this._seedLayer = undefined;
		}


		console.log("Seeding: ", zooms);
		/*        zooms.forEach(z => {
                    // Geo bbox to pixel bbox (as per given zoom level)...
                    var northEastPoint = this._map.project(bbox.getNorthEast(), z);
                    var southWestPoint = this._map.project(bbox.getSouthWest(), z);

                    // Then to tile coords bounds, as per GridLayer
                    var tileBounds = this._pxBoundsToTileRange(
                        L.bounds([northEastPoint, southWestPoint])
                    );
                    console.log(z, " Bounds: ", tileBounds);

                    for (var j = tileBounds.min.y; j <= tileBounds.max.y; j++) {
                        for (var i = tileBounds.min.x; i <= tileBounds.max.x; i++) {
                            var point = new L.Point(i, j);
                            point.z = z;
                            queue.push(this._getTileUrl(point));
                        }
                    }
                });*/


		var seedData = {
			bbox: bbox,
			minZoom: minZoom,
			maxZoom: maxZoom,
			queueLength: urls.length,
			layer: this._seedLayer,
		};
		this._cancelSeed = false;
		this.fire("seedstart", seedData);
		var tile = this._createTile();
		// tile._layer = this; //pretty sure this didnt do anything
		this._seedOneTile(tile, urls, seedData);
		return this;
	},

	_divideWork: function (array, workers) {

	},
	/**
	 * Dont know if this works might help on very slow internet lmk if you play with it
	 * @param bbox
	 * @param zooms
	 * @param workers
	 * @param options
	 * @returns {*}
	 */
	workerSeed: function (bbox, zooms, workers = 4, options) {
		if (!this.options.useCache) return;
		if (!this._map) return;

		if (this._seedLayer) {
			this._seedLayer.remove();
		}

		options = options || {};
		let animate = !!options.anamate

		let minZoom = Math.min(...zooms)
		let maxZoom = Math.max(...zooms)

		let urls
		if (animate) {
			let ts = this.testSeed(bbox, zooms);
			urls = ts.urls;
			this._seedLayer = ts.layer;
		} else {
			urls = this._getSeedUrls(bbox, zooms)
			this._seedLayer = undefined;
		}


		console.log("Seeding: ", zooms, "Workers: ", workers);

		let workerTiles = [];
		let workerUrls = [];
		let workerSeedData = [];
		this._cancelSeed = false;
		let workerPromise = [];

		for (let i = 0; i < workers; i++) {
			let w = workers;
			let n = urls.length
			let start = (i / w) * n;
			let length = (((i + 1) / w) * n) - start;
			workerUrls[i] = urls.splice(start, length);
			workerSeedData[i] = {
				bbox: bbox,
				minZoom: minZoom,
				maxZoom: maxZoom,
				queueLength: length,
				worker: w,
				start: start,
				length: length,
				totalLength: urls.length,
				layer: this._seedLayer,
			};

			workerTiles[i] = this._createTile();
			this.fire("seedstart", workerSeedData[i]);

			let worker = async ()=>{
				this._seedOneTile(workerTiles[i],  workerUrls[i],  workerSeedData[i]);
			}
			worker();

		}

		// var seedData = {
		//     bbox: bbox,
		//     minZoom: minZoom,
		//     maxZoom: maxZoom,
		//     queueLength: urls.length,
		//     layer: this._seedLayer,
		// };

		return this;
	},

	/**
	 * singnals the curent seed seed loop to stop
	 * will fire seedend and seedcancel events
	 */
	cancelSeed: function () {
		this._cancelSeed = false;
	},

	/**
	 * convertes a leaflet bounding box to tile bounds
	 * @param bbox
	 * @param zoom
	 * @return {*}
	 */
	bboxToTileBounds: function (bbox, zoom) {
		// Geo bbox to pixel bbox (as per given zoom level)...
		var northEastPoint = this._map.project(bbox.getNorthEast(), zoom);
		var southWestPoint = this._map.project(bbox.getSouthWest(), zoom);


		//copied from node_modules/leaflet/src/layer/tile/GridLayer.js
		let _pxBoundsToTileRange = (bounds) => {
			// var tileSize = this.getTileSize();//this breaks with continues zoom Mixin since that changes the tile size to scale them.
			//so we need to take the tile size from the options instead
			let tileSize = L.point(this.options.tileSize, this.options.tileSize)
			return L.bounds(
				bounds.min.unscaleBy(tileSize).floor(),
				bounds.max.unscaleBy(tileSize).ceil().subtract([1, 1]));
		}


		// Then to tile coords bounds, as per GridLayer
		var tileBounds = _pxBoundsToTileRange(
			L.bounds([northEastPoint, southWestPoint])
		);

		// console.log("Flush");
		// console.log();
		console.log("NWPoint: ", northEastPoint, "  SWPoint: ", southWestPoint, "  Zoom: ", zoom, " Bounds: ", tileBounds);
		return tileBounds;
	},

	/**
	 * Get the urls for seeding the cache
	 * @param {L.Bounds} bbox - map bounding box
	 * @param {int[]} zooms - the desicres zoom levels to cache
	 * @return {String[]} - an array of wms urls
	 * @private
	 */
	_getSeedUrls: function (bbox, zooms) {
		let urls = []
		for (let k = 0; k < zooms.length; k++) {
			let z = zooms[k];
			let tileBounds = this.bboxToTileBounds(bbox, z);

			// let range = tileBounds.max.subtract(tileBounds.min);
			// let numTiles = range.x * range.y;

			// console.log("Tile Count: ", numTiles);

			for (var j = tileBounds.min.y; j <= tileBounds.max.y; j++) {
				for (var i = tileBounds.min.x; i <= tileBounds.max.x; i++) {
					var point = new L.Point(i, j);
					point.z = z;
					urls.push(this._getTileUrl(point))
				}
			}
		}

		return urls
	},

	_updateLayerStyle: function (layer, status) {

		let color;
		let fillOpacity;
		switch (status) {
			case "cached":
				color = '#6666ff';
				fillOpacity = 0.2;
				break;
			case "success":
				color = '#66ff66';
				fillOpacity = 0.3;
				break;
			case "failed":
				color = '#db0606';
				fillOpacity = 0.5;
				break;
			case "pending":
				color = '#ffffff';
				fillOpacity = 0.3;
				break;
			default:
				color = '#eeff55';
				fillOpacity = 0.03;
				break;
		}

		layer.setStyle({
			fillColor: color,
			fillOpacity: fillOpacity,
			color: color,
			opacity: 1,
		})
		return;

	},
	/**
	 * test what will be seeded, returns an layer of features showing which tiles will be fetched
	 * @param {L.Bounds} bbox - map bounding box
	 * @param {int[]} zooms - the desicres zoom levels to cache
	 * @return {L.geoJson} - leaflet layer of the tiles to be seeded
	 */
	testSeed: function (bbox, zooms) {

		let featureCollection = {
			type: 'FeatureCollection',
			features: [],
		};

		let urls = this._getSeedUrls(bbox, zooms)
		for (let i = 0; i < urls.length; i++) {
			let feature = this.tileToFeature(urls[i])
			featureCollection.features.push(feature);
		}


		/*
                for (let k = 0; k < zooms.length; k++) {
                    let z = zooms[k];
                    let tileBounds = this.bboxToTileBounds(bbox, z);

                    let range = tileBounds.max.subtract(tileBounds.min);
                    let numTiles = range.x * range.y;

                    console.log("Tile Count: ", numTiles);

                    for (var j = tileBounds.min.y; j <= tileBounds.max.y; j++) {
                        for (var i = tileBounds.min.x; i <= tileBounds.max.x; i++) {
                            var point = new L.Point(i, j);
                            point.z = z;
                            let feature = this.tileToFeature(this._getTileUrl(point))
                            featureCollection.features.push(feature);
                        }
                    }
                }
        */

		let layer = L.geoJson(featureCollection, {
			style: (feature) => {
				let color = 'rgba(219,238,235,0.5)';
				let fillOpacity = 0;

				return {
					color: color,
					weight: 2,
					opacity: 0.6,
					fillColor: color,
					fillOpacity: fillOpacity
				}
			},
		});
		layer.addTo(this._map);
		return {
			layer: layer,
			urls: urls,
		}
	},

	/**
	 * Convert an tile url .../z/x/y.png to a geojson map feature
	 * @param tileurl - a wmts urll like .../z/x/y.png
	 * @param [properties] - additional properties to put in the geojson feature.
	 * @return {{geometry: {coordinates: *[][][], type: string}, type: string, properties: {x: T, y, z: T, url}}}
	 */
	tileToFeature: function (tileurl, properties) {

		let a = tileurl;
		let s = a.split('/')
		//["https:", "", "a.tile.openstreetmap.org", "10", "174", "348.png"]
		let y = s.pop().split('.')[0]
		// "348"
		let x = s.pop()
		// "174"
		let z = s.pop()
		// "10"

		if(isNaN(y) || isNaN(x) || isNaN(z)) {
			console.warn("Failed to make tile x,y,z isnan : ",x,", ",y,", ",z);
			return;
		}


		let tileSize = this.options.tileSize
		var topLeftPoint = new L.Point(
			x * tileSize,
			y * tileSize
		);
		var bottomRightPoint = new L.Point(
			topLeftPoint.x + tileSize,
			topLeftPoint.y + tileSize
		);

		var topLeftlatlng = L.CRS.EPSG3857.pointToLatLng(
			topLeftPoint,
			z
		);
		var botRightlatlng = L.CRS.EPSG3857.pointToLatLng(
			bottomRightPoint,
			z
		);

		properties = properties || {}
		properties.x = x;
		properties.y = y;
		properties.z = z;
		properties.url = a;
		return {
			type: 'Feature',
			properties: properties,
			geometry: {
				type: 'Polygon',
				coordinates: [
					[
						[topLeftlatlng.lng, topLeftlatlng.lat],
						[botRightlatlng.lng, topLeftlatlng.lat],
						[botRightlatlng.lng, botRightlatlng.lat],
						[topLeftlatlng.lng, botRightlatlng.lat],
						[topLeftlatlng.lng, topLeftlatlng.lat]]],
			},
		};

	},

	getStoredTilesAsGeojson: async function () {
		let layer = this
		let featureCollection = {
			type: 'FeatureCollection',
			features: [],
		};

		try {
			let res = await layer._db.allDocs({
				include_docs: true,
				attachments: true
			});

			console.log("Got DB:", res);
			console.log("Num Rows:", res.rows.length);

			for (let i = 0; i < res.rows.length; i++) {

				let r = res.rows[i];
				let p = {
					rev: r._rev,
				};
				if (this._errorDigest && r.doc && r.doc._attachments && r.doc._attachments.tile && r.doc._attachments.tile.digest
					&& r.doc._attachments.tile.digest === this._errorDigest) {
					p.errorCached = true;
				}

				if (r.id !== this.options.errorTileUrl) {//we cant draw that!
					let feature = this.tileToFeature(r.id, p);
					if(feature) {
						featureCollection.features.push(feature);

					}
				}
			}
		} catch (e) {
			console.error(e);
		}

		return featureCollection;
	},
	/**
	 * Returns a Leaflet Layer with all the cached tiles rendered can be slow
	 * adds it to the map for you.
	 * @returns {Promise<{features: *[], type: string}>}
	 */
	showStoredTiles: function () {
		return this.getStoredTilesAsGeojson().then(geojson => {

			this._cachedTileLayer = L.geoJSON(geojson, {
				style: (feature, latlng) => {

					let fill = '#91ff6c';
					if (feature.properties.errorCached) {
						fill = '#fc6262'
					}
					return {//https://leafletjs.com/reference-1.7.1.html#path-option
						fillColor: fill,
						color: '#000000',
					}
				}
			}).addTo(this._map);
			return this._cachedTileLayer;

		})

	},

	_createTile: function () {
		return document.createElement("img");
	},

	// Modified L.TileLayer.getTileUrl, this will use the zoom given by the parameter coords
	//  instead of the maps current zoomlevel.
	_getTileUrl: function (coords) {
		var zoom = coords.z;
		if (this.options.zoomReverse) {
			zoom = this.options.maxZoom - zoom;
		}
		zoom += this.options.zoomOffset;
		return L.Util.template(
			this._url,
			L.extend(
				{
					r:
						this.options.detectRetina &&
						L.Browser.retina &&
						this.options.maxZoom > 0
							? "@2x"
							: "",
					s: this._getSubdomain(coords),
					x: coords.x,
					y: this.options.tms
						? this._globalTileRange.max.y - coords.y
						: coords.y,
					z: this.options.maxNativeZoom
						? Math.min(zoom, this.options.maxNativeZoom)
						: zoom,
				},
				this.options
			)
		);
	},

	/**
	 * Uses a defined tile to eat through one item in the queue and
	 *   asynchronously recursively call itself when the tile has
	 *   finished loading.
	 * @param {Image} tile - the tile dom element for loading tiles from _createTile()
	 * @param {String[]} remaining - queue of remaining tiles
	 * @param {Object} seedData - data for seed events
	 * @private
	 */
	_seedOneTile: function (tile, remaining, seedData) {

		seedData.remainingLength = remaining.length;
		if (!remaining.length) {
			this.fire("seedend", seedData);
			return;
		}
		if (this._cancelSeed) {
			this.fire("seedcancel", seedData);
			this.fire("seedend", seedData);
			return;
		}


		var url = remaining.shift();
		let layer;
		if (seedData.layer) {
			layer = seedData.layer.getLayers().find(l => l.feature.properties.url == url);
		}
		if (layer) {
			this._updateLayerStyle(layer, 'pending');
		}
		// this.fire("seedprogress", {
		//     bbox: seedData.bbox,
		//     minZoom: seedData.minZoom,
		//     maxZoom: seedData.maxZoom,
		//     queueLength: seedData.queueLength,
		//     remainingLength: remaining.length,
		//     url: url,
		// });

		let progData = {
			bbox: seedData.bbox,
			minZoom: seedData.minZoom,
			maxZoom: seedData.maxZoom,
			queueLength: seedData.queueLength,
			remainingLength: remaining.length,
			url: url,
			worker: seedData.worker,
			totalLength: seedData.totalLength || seedData.queueLength,
		}

		this._db.get(
			url,
			function (err, data) {
				if (err) {
					console.error(err);
					console.debug(`Tile Not Found In Puchdb status: ${err.status}, msg: ${err.msg} Trying TO Fetch It Again`)
				}
				// console.log("db_get: ", err, data);
				if (!data) {
					/// FIXME: Do something on tile error!!

					tile.onload = function (ev) {
						progData.status = 'success'
						if (layer) {
							this._updateLayerStyle(layer, 'success');
						}
						this.fire("seedprogress", progData);
						this._saveTile(tile, url, null); //(ev)
						this._seedOneTile(tile, remaining, seedData);
					}.bind(this);

					tile.onerror = function (ev) {
						progData.status = 'failed'
						if (layer) {
							this._updateLayerStyle(layer, 'failed');
						}
						console.error("SEED TILE FAILED: ", ev)
						this.fire("seedprogress", progData);

						//todo: go back and try again online later

						// this._saveTile(tile, url, null); //(ev)
						this._seedOneTile(tile, remaining, seedData);
					}.bind(this);

					tile.crossOrigin = "Anonymous";
					tile.src = url;
				} else {
					//already cached
					progData.status = 'cached'
					if (layer) {
						this._updateLayerStyle(layer, 'cached');
					}
					this.fire("seedprogress", progData);
					this._seedOneTile(tile, remaining, seedData);
				}
			}.bind(this)
		);
	},
});
