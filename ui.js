
/** ///////////////////////////////////////////////////////////////////
 * 
 * Functions to facilitate the creation of user interfaces. Right now
 * only useful to automate the creation of time series viewers
 * 
 ** /////////////////////////////////////////////////////////////////*/

// Global variables 
var horizontalStyle = {stretch: 'horizontal', width: '100%'}
var inputUtils = require('users/ytzhang/glance_yz:ccdcUtilities/inputs.js')
var ccdcUtils = require('projects/GLANCE:ccdcUtilities/ccdc.js')
var changeUtils = require('projects/GLANCE:ccdcUtilities/change.js') 

// Set default ccd params
var BANDS = ['BLUE','GREEN','RED', 'NIR', 'SWIR1', 'SWIR2'] 
var BPBANDS = ['GREEN', 'RED', 'NIR', 'SWIR1', 'SWIR2']
var TMBANDS = ['GREEN', 'SWIR2']
var proj = ee.Projection("EPSG:4326").atScale(30)
var dateFormat = 1
var lambda = 20/10000
var maxIter = 10000
var defaultCcdParams = {   
    breakpointBands: BPBANDS,
    tmaskBands: TMBANDS,
    dateFormat: dateFormat,
    lambda: lambda,
    maxIterations: maxIter
  }

var CCDCRESULTS = ee.ImageCollection("projects/CCDC/v2")
                    .filterMetadata('system:index', 'starts_with', "z_")



/**
* Load imaged clicked in time series chart
* @param {ee.Map} mapObj An ee.Map() instance
* @param {ee.Geometry} geometry ee.Geometry of the location used to filter the TS collection
* @param {String} date Date in any format accepted by ee.Date()
* @param {Dictionary} vizParams Dictionary specifying viz parameters. Must include keys:
*                               'red', 'green', 'blue', 'redMin', 'redMax', 
*                               'greenMin', 'greenMax', 'blueMin', 'blueMax'
* @param {ee.Projection} projection Optional parameter to reproject selected image to 
*                                   specified projection. Otherwise the original image
*                                   will be retrieved
*/
var getImageRegion = function(mapObj, geometry, date, vizParams, projection) {
  var imDate = ee.Date(date)
  var befDate = imDate.advance(-1, 'day')
  var aftDate = imDate.advance(1, 'day')
  
  var col = inputUtils.generateCollection(geometry, befDate, aftDate).select(BANDS)
  
  // Only reproject if specified. Useful for checking against layers in different projections
  if (projection){
    var selectedImage =  inputUtils.doIndices(col).first().reproject(projection, null, 30)
  } else {
    var selectedImage =  inputUtils.doIndices(col).first()
  }

  selectedImage.get('system:index').evaluate(function(obj) {
    var bandList = [vizParams['red'], vizParams['green'], vizParams['blue']]
    var minList = [vizParams['redMin'], vizParams['greenMin'], vizParams['blueMin']]
    var maxList = [vizParams['redMax'], vizParams['greenMax'], vizParams['blueMax']]
    // Get current number of layers to add images just below the outline of the clicked pixel, which
    // should be always on top, but on top of other existing images
    var numLayers = mapObj.layers().length()
    var insertIndex = numLayers - 1
    // Use insert to preserve clicked box on top and shift any other existing bands
    mapObj.layers().insert(insertIndex, ui.Map.Layer(ee.Image(selectedImage), {bands: bandList, min: minList, max: maxList}, obj))
  })
}

/**
* Get Landsat pixel bounds in a given projection
* @param {ee.Geometry.Point} point A point geometry
* @param {ee.Projection or EPSG code} projection Projection to use for retrieving the pixel bounds
* @returns {ee.Geometry} Bounds of the intersecting pixel in the specified projection
*/
function getBounds(point, projection){
  var toProj = ee.Projection(projection).atScale(30)
  var c1 = point.transform(toProj, 1).coordinates()
    .map(function(p) {
      return ee.Number(p).floor()
    })
  var c2 = c1.map(function(p) { return ee.Number(p).add(1) })
  var p2 =  ee.Geometry.LineString([c1, c2], toProj)
  return p2.bounds()
}


/**
* Format time series to make them suitable for the charting, and smooth segments if selected
* @param {ee.ImageCollection} collection ee.ImageCollection with the images used in CCD
* @param {Number} dateFormat Date format as accepted by the CCD algorithm
* @param {ee.Image} ccdc CCD results
* @param {ee.Geometry} geometry ee.Geometry used to retrieve the time series
* @param {String} band Band to chart
* @param {Number} padding Padding factor to smooth the temporal segments
* @returns {ee.ImageCollection} ee.ImageCollection suitable for charting
*/
function ccdcTimeseries(collection, dateFormat, ccdc, geometry, band, padding) {
  function harmonicFit(t, coef) {
    var PI2 = 2.0 * Math.PI
    var OMEGAS = [PI2 / 365.25, PI2, PI2 / (1000 * 60 * 60 * 24 * 365.25)]
    var omega = OMEGAS[dateFormat];
    return coef.get([0])
      .add(coef.get([1]).multiply(t))
      .add(coef.get([2]).multiply(t.multiply(omega).cos()))
      .add(coef.get([3]).multiply(t.multiply(omega).sin()))
      .add(coef.get([4]).multiply(t.multiply(omega * 2).cos()))
      .add(coef.get([5]).multiply(t.multiply(omega * 2).sin()))
      .add(coef.get([6]).multiply(t.multiply(omega * 3).cos()))
      .add(coef.get([7]).multiply(t.multiply(omega * 3).sin()));
  };

  function convertDateFormat(date, format) {
    if (format == 0) { 
      var epoch = 719529;
      var days = date.difference(ee.Date('1970-01-01'), 'day')
      return days.add(epoch)
    } else if (format == 1) {
      var year = date.get('year')
      var fYear = date.difference(ee.Date.fromYMD(year, 1, 1), 'year')
      return year.add(fYear)
    } else {
      return date.millis()
    }
  }

  function date_to_segment(t, fit) {
    var tStart = ee.Array(fit.get('tStart'));
    var tEnd = ee.Array(fit.get('tEnd'));
    return tStart.lte(t).and(tEnd.gte(t)).toList().indexOf(1);
  };

  function produceTimeSeries(collection, ccdc, geometry, band) {

    var ccdcFits = ccdc.reduceRegion({
      reducer: ee.Reducer.first(), 
      geometry: geometry, 
      crs: proj
    })
    
    
    if (padding) {
      collection = collection.sort('system:time_start')

      var first = collection.first()
      var last = collection.sort('system:time_start', false).first()
      var fakeDates = ee.List.sequence(first.date().get('year'), last.date().get('year'), padding).map(function(t) {
        var fYear = ee.Number(t);
        var year = fYear.floor()
        return  ee.Date.fromYMD(year, 1, 1).advance(fYear.subtract(year), 'year')
      })
      fakeDates = fakeDates.map(function(d) { 
        return ee.Image().rename(band).set('system:time_start', ee.Date(d).millis())
      })
      collection = collection.merge(fakeDates)
    }    
    
    collection = collection.sort('system:time_start')

    /** Augment images with the model fit. */
    var timeSeries = collection.map(function(img) {
      var time = convertDateFormat(img.date(), dateFormat)
      var segment = date_to_segment(time, ccdcFits)
      var value = img.select(band).reduceRegion({
        reducer: ee.Reducer.first(), 
        geometry: geometry,
        crs: proj
      }).getNumber(band)
      
      var coef = ee.Algorithms.If(segment.add(1), 
        ccdcFits.getArray(band + '_coefs')
          .slice(0, segment, segment.add(1))
          .project([1]),
        ee.Array([0,0,0,0,0,0,0,0,0]))
      
      var fit = harmonicFit(time, ee.Array(coef))
      return img.set({
        value: value,
        fitTime: time,
        fit: fit,
        coef: coef,
        segment: segment,
        dateString: img.date().format("YYYY-MM-dd")
      }).set(segment.format("h%d"), fit)
    })
    return timeSeries
  }
  
  return produceTimeSeries(collection, ccdc, geometry, band)
  
}
  
/**
* Generate chart of time series and CCD temporal segments
* TODO: doctstring
* @returns {{
*/
function chartTimeseries(table, band, lat, lon, nSegs) {
  nSegs = nSegs || 6
  
  // Get alphabet letter using index
  function getLetter(x){
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    var charCode = alphabet.charCodeAt(x)
    return String.fromCharCode(charCode)
  }
  
  // Build dictionary required to create custom segment chart 
  function buildDict(letter, index){
    var fitName = 'fit '.concat(index.toString())
    return {id: letter, label: fitName, type: 'number'}
  }
  
  // Everything in here is client-side javascript.
  function formatAsDataTable(table) {
    
    // Generate dictionaries for n segments and append to list
    var cols = [{id: 'A', label: 'Date', type: 'date'},
            {id: 'B', label: 'Observation', type: 'number'}]
    for (var i = 1; i < nSegs+1; i++) {
      var dict = buildDict(getLetter(i+1), i)
      cols.push(dict)
    }
    
    var values = table.map(function(list) {
      return {c: list.map(function(item, index) {
          return {"v": index == 0 ? new Date(item) : item }
        })
      }
    })
    return {cols: cols, rows: values}
  }

  /** Compute the limits of the given column */
  function getLimits(table, column) {
    var col = table.map(function(l) { return l[column]; }).filter(function(i) { return i != null })
    return [Math.min.apply(Math, col), Math.max.apply(Math, col)]
  }

  var limits = getLimits(table, 8)
  var formatted = formatAsDataTable(table)
  return ui.Chart(formatted, 'LineChart', {
      // Need at least 4 decimals to distinguish a 30 m pixel for the next
      title: 'CCDC TS, Latitude, Longitude: ' + lat.toFixed(4) + ', ' + lon.toFixed(4),
      pointSize: 0,
      series: {
        0: { pointSize: 1.8, lineWidth: 0},
      },
      vAxis: {
        title: 'Surface reflectance (' + band + ')',
        viewWindowMode: 'explicit', 
        viewWindow: {
          min: limits[0] * 0.9,
          max: limits[1] * 1.1
        }
      },
      height: '90%', //If 100%, chart starts growing if split panel is resized
      stretch: 'both',
      explorer: {} ,
  })
}


// var defaultRunParams = {sDate: '1985-01-01', eDate:'2020-01-01', bandSelect:'SWIR1', nSegs: 6}
var defaultRunParams = {sDate: '1985-01-01', eDate:'2020-12-31', bandSelect:'SWIR1', nSegs: 6}
var defaultVizParams = {red: 'SWIR1', green: 'NIR', blue: 'RED', 
                        redMin: 0, redMax: 0.6, 
                        greenMin: 0, greenMax: 0.6, 
                        blueMin: 0, blueMax: 0.6,
                        tsType: "Time series"
}

// TODO: doctstring
function chartCcdc(ccdParams, runParams, vizParams, 
                    geometry, panel, latitude, longitude, mapObj, 
                    omBool, comBool, savedBool){
  
  ccdParams = ccdParams || defaultCcdParams
  runParams = runParams || defaultRunParams
  vizParams = vizParams || defaultVizParams
  omBool = omBool || false
  comBool = comBool || false
  savedBool = savedBool || false
  
  // Filter collection and run depending on whether we are charting live or saved results
  if (savedBool === true){
    // Remove Landsat 4 bc it was not included in Noel's run
    var collection = inputUtils.generateCollection(geometry, runParams['sDate'], runParams['eDate'])
                                    .select(BANDS)
                                    .filterMetadata("SATELLITE", "not_equals", "LANDSAT_4")
    ccdParams['collection'] =  inputUtils.doIndices(collection)                                
    var ccdc_tile = ee.Image(CCDCRESULTS.filterBounds(geometry).first())                       
  
  } else if (savedBool === false) {
    // Need to filter bands because indices code does not currently work if TEMP is included
    var collection = inputUtils.generateCollection(geometry, runParams['sDate'], runParams['eDate']).select(BANDS)  
    ccdParams['collection'] =  inputUtils.doIndices(collection)
    var ccdc_tile = ee.Algorithms.TemporalSegmentation.Ccdc(ccdParams)
  }
  
  
  // Run omission and commission on pixel if requested
  var SEGS = ["S1", "S2", "S3", "S4", "S5", "S6"] 
  var ccdImage = ccdcUtils.buildCcdImage(ccdc_tile, SEGS.length, BANDS)
  var col = collection.map(changeUtils.createTimeBand)
  
  if (comBool) {
    print("Running commission test")
    
    // Map over all segment pairs
    var firstSeg = SEGS.slice(0,5)
    var secondSeg = SEGS.slice(1,6)
    var segPairs = firstSeg.map(function(e, i) {
      return [e, secondSeg[i]];
    })
    
    var commissionSegs = segPairs.map(function(s){
      return ee.Image(changeUtils.getCommission(col, ccdImage, s[0], s[1], 'SWIR1'))
                .rename([s[0].concat('_', s[1], '_chow_F'), s[0].concat('_',s[1], '_prob')])
    })
    var commImg = ee.Image.cat(commissionSegs)
    print(commImg.reduceRegion(ee.Reducer.mean(), geometry, 30))
    
  }
  
  if (omBool) {
    print("Running omission test")
    
    var critVal = 1.63
    var omissionSegs = SEGS.map(function(s){
      return ee.Image(changeUtils.getOmission(col, ccdImage, s, 'SWIR1', critVal))
               .rename([s.concat('_omission'), s.concat('_maxCusum')])
    })

    var omImg = ee.Image.cat(omissionSegs)
    print(omImg.reduceRegion(ee.Reducer.mean(), geometry, 30))
  
  }

  var series = ccdcTimeseries(ccdParams['collection'], ccdParams['dateFormat'], ccdc_tile, geometry, runParams['bandSelect'], 0.1)

  // Snap click box to image in original projection (e.g. UTM zone n)
  var ref_image =ee.Image(ccdParams['collection'].first()) 
  
  // Use native projection if live
  if (savedBool === true){
    var bounds = getBounds(geometry, ee.Projection("EPSG:4326"))
  } else if (savedBool === false){
    var bounds = getBounds(geometry, ref_image.projection())  
  }
  
  // High number 'ensures' this layer is added on top unless there's that many layers loaded already
  mapObj.layers().insert(20, ui.Map.Layer(bounds, {}, 'clicked'))
  
  // mapObj.addLayer(series, {}, "series", false)

  // Get required list programatically for n segments
  var templist = ["dateString", "value" ]
  for (var i = 0; i < runParams['nSegs']; i++) {
    templist.push("h".concat(i.toString()))
  }
  templist.push("fit")
  var listLength = templist.length
  
  var table = series.reduceColumns(ee.Reducer.toList(listLength, listLength), templist)
                    .get('list')

  // Use evaluate so we don't lock up the browser.
  table.evaluate(function(t, e) {
    // nSegs MUST be integer
    var chart = chartTimeseries(t, runParams['bandSelect'], latitude, longitude, runParams['nSegs'])
    // panel.widgets().reset([chart])
    // This is the original code working
    panel.widgets().set(0, chart) 
    // This is the new code for testing that simplifies integration with landtrendr, but breaks resizing figure
    // panel.add(chart) 
    chart.onClick(function(x) {
      if (x) {
        if (savedBool === true){
          getImageRegion(mapObj, geometry, x, vizParams, ee.Projection("EPSG:4326"))
        } else if (savedBool === false){
          getImageRegion(mapObj, geometry, x, vizParams)  
        }
        
      }
    })
  })
}  

// TODO: doctstring
function chartReverseCcdc(ccdParams, runParams, vizParams, 
                    geometry, panel, latitude, longitude, mapObj, 
                    omBool, comBool, savedBool){
  
  ccdParams = ccdParams || defaultCcdParams
  runParams = runParams || defaultRunParams
  vizParams = vizParams || defaultVizParams
  omBool = omBool || false
  comBool = comBool || false
  savedBool = savedBool || false
  
  // Filter collection and run depending on whether we are charting live or saved results
  if (savedBool === true){
    // Remove Landsat 4 bc it was not included in Noel's run
    var collection = inputUtils.generateCollection(geometry, runParams['sDate'], runParams['eDate'])
                                    .select(BANDS)
                                    .filterMetadata("SATELLITE", "not_equals", "LANDSAT_4")
    ccdParams['collection'] =  inputUtils.doIndices(collection)                                
    var ccdc_tile = ee.Image(CCDCRESULTS.filterBounds(geometry).first())                       
  
  } else if (savedBool === false) {
    // Need to filter bands because indices code does not currently work if TEMP is included
    var collection = inputUtils.generateCollection(geometry, runParams['sDate'], runParams['eDate']).select(BANDS)  
    ccdParams['collection'] =  inputUtils.doIndices(collection)
    var ccdc_tile = ee.Algorithms.TemporalSegmentation.Ccdc(ccdParams)
  }
  
  
  // Run omission and commission on pixel if requested
  var SEGS = ["S1", "S2", "S3", "S4", "S5", "S6"] 
  var ccdImage = ccdcUtils.buildCcdImage(ccdc_tile, SEGS.length, BANDS)
  var col = collection.map(changeUtils.createTimeBand)
  
  if (comBool) {
    print("Running commission test")
    
    // Map over all segment pairs
    var firstSeg = SEGS.slice(0,5)
    var secondSeg = SEGS.slice(1,6)
    var segPairs = firstSeg.map(function(e, i) {
      return [e, secondSeg[i]];
    })
    
    var commissionSegs = segPairs.map(function(s){
      return ee.Image(changeUtils.getCommission(col, ccdImage, s[0], s[1], 'SWIR1'))
                .rename([s[0].concat('_', s[1], '_chow_F'), s[0].concat('_',s[1], '_prob')])
    })
    var commImg = ee.Image.cat(commissionSegs)
    print(commImg.reduceRegion(ee.Reducer.mean(), geometry, 30))
    
  }
  
  if (omBool) {
    print("Running omission test")
    
    var critVal = 1.63
    var omissionSegs = SEGS.map(function(s){
      return ee.Image(changeUtils.getOmission(col, ccdImage, s, 'SWIR1', critVal))
               .rename([s.concat('_omission'), s.concat('_maxCusum')])
    })

    var omImg = ee.Image.cat(omissionSegs)
    print(omImg.reduceRegion(ee.Reducer.mean(), geometry, 30))
  
  }

  var series = ccdcTimeseries(ccdParams['collection'], ccdParams['dateFormat'], ccdc_tile, geometry, runParams['bandSelect'], 0.1)

  // Snap click box to image in original projection (e.g. UTM zone n)
  var ref_image =ee.Image(ccdParams['collection'].first()) 
  
  // Use native projection if live
  if (savedBool === true){
    var bounds = getBounds(geometry, ee.Projection("EPSG:4326"))
  } else if (savedBool === false){
    var bounds = getBounds(geometry, ref_image.projection())  
  }
  
  // High number 'ensures' this layer is added on top unless there's that many layers loaded already
  mapObj.layers().insert(20, ui.Map.Layer(bounds, {}, 'clicked'))
  
  // mapObj.addLayer(series, {}, "series", false)

  // Get required list programatically for n segments
  var templist = ["dateString", "value" ]
  for (var i = 0; i < runParams['nSegs']; i++) {
    templist.push("h".concat(i.toString()))
  }
  templist.push("fit")
  var listLength = templist.length
  
  var table = series.reduceColumns(ee.Reducer.toList(listLength, listLength), templist)
                    .get('list')

  // Use evaluate so we don't lock up the browser.
  table.evaluate(function(t, e) {
    // nSegs MUST be integer
    var chart = chartTimeseries(t, runParams['bandSelect'], latitude, longitude, runParams['nSegs'])
    // panel.widgets().reset([chart])
    // This is the original code working
    panel.widgets().set(0, chart) 
    // This is the new code for testing that simplifies integration with landtrendr, but breaks resizing figure
    // panel.add(chart) 
    chart.onClick(function(x) {
      if (x) {
        if (savedBool === true){
          getImageRegion(mapObj, geometry, x, vizParams, ee.Projection("EPSG:4326"))
        } else if (savedBool === false){
          getImageRegion(mapObj, geometry, x, vizParams)  
        }
        
      }
    })
  })
}  


function chartDOY(runParams, mapObj, geometry, panel, lat, lon){
  
  runParams = runParams || defaultRunParams
  
  var col = inputUtils.getLandsat(runParams['sDate'], runParams['eDate'], 1, 366, geometry)
  var ref_image =ee.Image(col.first()) 
  var bounds = getBounds(geometry, ref_image.projection())

  // High number 'ensures' this layer is added on top unless there's that many layers loaded already
  mapObj.layers().insert(20, ui.Map.Layer(bounds, {}, 'clicked'))
  
  var chart = ui.Chart.image.doySeries({
    imageCollection: col.select([runParams['bandSelect']]), 
    region: geometry, 
    scale: 30,
    regionReducer: ee.Reducer.first()
    })
    .setChartType("ScatterChart")
    .setOptions({
      title: 'DOY Plot, Latitude, Longitude: ' + lat.toFixed(4) + ', ' + lon.toFixed(4),
      pointSize: 0,
      series: {
        0: { pointSize: 2},
      },
      vAxis: {
        title: 'Surface reflectance (' + runParams['bandSelect'] + ')',
      },
      hAxis: {
        title: "Day of year",
        viewWindowMode: 'explicit', 
        viewWindow: {
          min: 0,
          max: 366
        }
      },
      height: '90%', //If 100%, chart starts growing if split panel is resized
      stretch: 'both',
      explorer: {} ,
    })

  panel.widgets().set(0, chart) 
  
}


/**
* Create full, add-on interface with defaults and basic widgets to interact with time series
* @param {ee.Map} mapObj An ee.Map() instance
* @param {dict} ccdParams Optional dictionary with argument to pass to the CCD algorithm
* @returns {ee.SplitPanel} ee.SplitPanel with map and controls on top, and chart in bottom
*/
function initializeTSViewer(mapObj, ccdParams, runParams, vizParams, omBool, comBool, savedBool) {
  ccdParams = ccdParams || defaultCcdParams
  runParams = runParams || defaultRunParams
  vizParams = vizParams || defaultVizParams
  omBool = omBool || false
  comBool = comBool || false
  savedBool = savedBool || false
  
  var locationButton = ui.Button({
  label:'User location',
  style:{stretch: 'horizontal', backgroundColor: 'rgba(255, 255, 255, 0.0)'}
  })
  
  locationButton.onClick(function() {
  var geoSuccess = function(position) {
    var lat = position.coords.latitude;
    var lon = position.coords.longitude;
     if (navigator.geolocation) {
      var point = ee.Geometry.Point([lon, lat])
      mapObj.centerObject(point)
      mapObj.addLayer(point, {color:'#0099ff'}, "Current location")
    }
    else {
      console.log('Geolocation is not supported for this Browser/OS.');
    }
  };
  navigator.geolocation.getCurrentPosition(geoSuccess);

  });
  
  var waitMsg = ui.Label({
    value: 'Processing, please wait',
    style: {
      position: 'bottom-left',
      stretch: 'horizontal',
      textAlign: 'center',
      fontWeight: 'bold',
      backgroundColor: 'rgba(255, 255, 255, 0.0)'
    }
  });
  
  var sDate = ui.Textbox({
    placeholder: "Start date in 'yyyy-mm-dd' format",
    value: '1997-01-01',
    style:{stretch: 'horizontal', backgroundColor: 'rgba(255, 255, 255, 0.0)'}
  })

  var eDate = ui.Textbox({
    placeholder: "End date in 'yyyy-mm-dd' format",
    value: '2020-01-01',
    style:{stretch: 'horizontal', backgroundColor: 'rgba(255, 255, 255, 0.0)'}
  })
  
  var chartPanel = ui.Panel({
  style: {
    height: '30%',
    width: '100%',
    position: 'bottom-center',
    padding: '0px',
    margin: '0px',
    border: '0px',
    // whiteSpace:'nowrap',
    stretch: 'both',
    backgroundColor: 'rgba(255, 255, 255, 0.5)'
    } 
  });
  
  
  var bandSelect = ui.Select({items:BANDS, value:'SWIR1', 
    style:{stretch: 'horizontal', backgroundColor: 'rgba(255, 255, 255, 0.0)'
  }});
  
  
  // Map callback function, set the first time and after map is cleared
  var mapCallback = function(coords) {
    // Re-set runParams
    runParams['sDate'] = sDate.getValue()
    runParams['eDate'] = eDate.getValue()
    runParams['bandSelect'] = bandSelect.getValue()
    
    if(dirtyMap === false){
      //mapObj.widgets().set(1, chartPanel)
      dirtyMap = true;
    }
    chartPanel.clear();
    chartPanel.add(waitMsg);
    
    var geometry = ee.Geometry.Point([coords.lon, coords.lat]);
    // Run ccdc and get time series
    chartCcdc(ccdParams, runParams, vizParams, geometry, chartPanel, 
              coords.lat, coords.lon, mapObj, omBool, comBool, savedBool) 
  }

  var clearMap = ui.Button({label: 'Clear map', 
                            onClick:function(){
                                      mapObj.clear()
                                      mapObj.widgets().set(0, controlPanel);
                                      // Need to restablish callback after map.clear
                                      dirtyMap = false
                                      mapObj.setControlVisibility({zoomControl:false, layerList:true})
                                      mapObj.onClick(mapCallback)
                            },
                            style:{stretch: 'horizontal'}
  })
  
  // Floating widget with map controls
  var controlPanel = ui.Panel({
    widgets: [bandSelect, sDate, eDate, locationButton, clearMap], //label,
    style: {
      height: '230px',
      width: '120px',
      position: 'top-left',
      backgroundColor: 'rgba(255, 255, 255, 0)'
      
    }
  });
  
  // Set initial map options
  var dirtyMap = false
  mapObj.onClick(mapCallback) 
  mapObj.setOptions('SATELLITE');
  mapObj.widgets().set(0, controlPanel);
  mapObj.setControlVisibility({zoomControl:false, layerList:true})
  mapObj.style().set({cursor:'crosshair'});
  return ui.SplitPanel(mapObj, chartPanel, 'vertical')
  
}

/**
* Create standalone chart with time series and CCDC segments
* @param {ee.Map} mapObj An ee.Map() instance
* @param {dict} runParams Dictionary with arguments to filter collection
* @param {dict} ccdParams Dictionary with argument to pass to the CCD algorithm
* @returns {ee.Chart} ee.Chart linked to the input map
*/
function getTSChart(mapObj, ccdParams, runParams, vizParams, omBool, comBool, savedBool) {
  ccdParams = ccdParams || defaultCcdParams
  runParams = runParams || defaultRunParams
  vizParams = vizParams || defaultVizParams
  omBool = omBool || false
  comBool = comBool || false
  savedBool = savedBool || false
  
  var waitMsg = ui.Label({
    value: 'Processing, please wait',
    style: {
      position: 'bottom-left',
      stretch: 'horizontal',
      textAlign: 'center',
      fontWeight: 'bold',
      backgroundColor: 'rgba(255, 255, 255, 0.0)'
    }
  });
  
  var chartPanel = ui.Panel({
  style: {
    height: '30%',
    width: '100%',
    position: 'bottom-center',
    padding: '0px',
    margin: '0px',
    border: '0px',
    // whiteSpace:'nowrap',
    stretch: 'both',
    backgroundColor: 'rgba(255, 255, 255, 0.5)'
    } 
  });
  
  // Map callback function, set the first time and after map is cleared
  var mapCallback = function(coords) {
    if(dirtyMap === false){
      //mapObj.widgets().set(1, chartPanel)
      dirtyMap = true;
    }
    chartPanel.clear();
    chartPanel.add(waitMsg);
    
    var geometry = ee.Geometry.Point([coords.lon, coords.lat]);
    
    // Retrieve time series of DOY plot
    if (vizParams.tsType == "Time series"){
      chartCcdc(ccdParams, runParams, vizParams, geometry, chartPanel, 
              coords.lat, coords.lon, mapObj, omBool, comBool, savedBool)
    
    } else if (vizParams.tsType == "DOY") {
      chartDOY(runParams, mapObj, geometry, chartPanel,
                coords.lat, coords.lon)
    }
  }
  // Set initial map options and link map and chart
  var dirtyMap = false
  mapObj.onClick(mapCallback) 
  
  return chartPanel
  
}



/**
 * return an image with number of observation at an annual step
 * the last param is for including/excluding Landsat7 data after 2014
 */
function getAnnualNumOfObs(sYear, eYear, sMonth, eMonth, geometry, L7){

  // de-duplicated
  var timeAxis = 0
  var bandAxis = 1
  var dedupe = function(array) {
    var time = array.arraySlice(bandAxis, -1)
    var sorted = array.arraySort(time)
    var doy = sorted.arraySlice(bandAxis, -2, -1)
    var left = doy.arraySlice(timeAxis, 1)
    var right = doy.arraySlice(timeAxis, 0, -1)
    var mask = ee.Image(ee.Array([[1]]))
        .arrayCat(left.neq(right), timeAxis)
    return array.arrayMask(mask)
  };
  
  var startDate = sYear.toString() + "-" + sMonth.toString() + "-" + '1'
  var endDate = eYear.toString() + "-" + eMonth.toString() + "-" + '31'
  
  var collection = inputUtils.generateCollection(geometry, startDate, endDate).select('SWIR1')


  if (L7) {
    var imgCol = collection
  } else{
    var imgCol = collection.filterMetadata('SATELLITE','not_equals','LANDSAT_7')
  }
  
  // Add time band
  imgCol = imgCol.map(function(image) {
    var time = image.metadata('system:time_start')
    var date = image.date();
    var doy = date.getRelative('day', 'year')
    var doyImage = ee.Image(doy)
        .rename('doy')
        .int()
    return image.addBands(doyImage).addBands(time).clip(image.geometry())
  })
  
  var array = imgCol.toArray()
  // remove endlaps
  var deduped = dedupe(array)
  var nobs = deduped.arrayLengths().arrayGet([0])
  
  return nobs
}



/**
 * Automate the creation of a horizontal panel with label and selector
 * @param {String}        name        Name of label to use
 * @parame {List}         items       List with items to use in the selector
 * @returns {ee.Panel}                Horizontal panel with label and selector with given items
**/

function generateSelectorPanel(name, items){
  var selectorPanel = ui.Panel(
    [
      ui.Label({value: name, style:{stretch: 'horizontal', color:'black'}}),
      ui.Select({items: items, style:{stretch: 'horizontal'}}) 
    ],
    ui.Panel.Layout.Flow('horizontal'),
    horizontalStyle
  )
  return selectorPanel
}

/**
 * Automate the creation of a vertical colorbar legend
 * @param {String}        min        Lower colorbar value 
 * @param {String}        max        Higher colorbar value 
 * @parame {List}         palette    List of colors
 * @returns {ee.Panel}               ee.Panel with thumbnail colorbar
**/

function generateColorbarLegend(min, max, palette, orientation, title){
   var viz = {min:min, max:max, palette:palette};
   
   if (orientation == 'vertical'){
     
     var layout = ui.Panel.Layout.flow('vertical', false)
     var coordinate = 'latitude'
     var params = {bbox:'0,0,10,100', dimensions:'10x200'}
     var width = '50px'
     
   } else if (orientation == 'horizontal'){
     
     var layout = ui.Panel.Layout.flow('horizontal', false)
     var coordinate = 'longitude'
     var params = {bbox:'0,0,100,10', dimensions:'200x10'}
     var width = '330px'
     var labwidth = '40px'
     
   } else {
     
     print("Orientation must be 'vertical' or 'horizontal'")
     
   }
   
    // set position of panel
    var legend = ui.Panel({
      style: {
        position: 'middle-left',
      },
      layout: layout
    });
     
    // create the legend image
    var lon = ee.Image.pixelLonLat().select(coordinate)
    var gradient = lon.multiply((viz.max-viz.min)/100.0).add(viz.min);
    var legendImage = gradient.visualize(viz);
     
    // create text for max value
    var maxPanel = ui.Panel({
      widgets: [
        ui.Label(viz['max'])
      ],
      style: {width: labwidth}
    })

    // create thumbnail from the image
    var thumbnail = ui.Thumbnail({
      image: legendImage,
      params: params,
      style: {padding: '1px', position: 'bottom-center'}
    });

    // create text for min value
    var minPanel = ui.Panel({
      widgets: [
        ui.Label(viz['min'])
      ],
      style: {width: labwidth}
    });
     
    // Organize panel and return
    if (orientation == 'vertical'){
      
      legend.add(maxPanel)
      legend.add(thumbnail)
      return legend.add(minPanel)
      
    } else if (orientation == 'horizontal'){
      
      legend.add(minPanel)
      legend.add(thumbnail)
      var outpanel = legend.add(maxPanel)
      
      return ui.Panel({widgets: [
        ui.Label({
          value: title,
          style: {
            padding: '1px', 
            position: 'top-center',
            
          }
        }),
        outpanel
        ], 
        style: {
          position: 'middle-left',
          width: width
        }})
    }  
}


var makeTextPanel = function(label, value, stretch) {
  return ui.Panel(
  [
    ui.Label({value:label, style:{stretch: stretch, color:'black'}}),
    ui.Textbox({value:value, style:{stretch: stretch}}),

  ],
  ui.Panel.Layout.Flow(stretch),
  horizontalStyle
);
}

var arrayRemove = function(arr, value) {
   return arr.filter(function(ele){
       return ele != value;
   });
}

var makeCheckbox = function(label, inputs) {
  return ui.Checkbox({
    label: label, 
    value: true,
    onChange: function(b) {
      if (!b) {
        inputs = arrayRemove(inputs, label)
      } else {
        inputs.push(label)
      }
      // return inputs
    }  
  })
}

var makePanel = function(stretch, widgets) {
 return ui.Panel(
    widgets,
    ui.Panel.Layout.Flow(stretch)); 
}




exports = {
  getImageRegion: getImageRegion,
  getBounds: getBounds,
  chartCcdc: chartCcdc,
  getTSChart: getTSChart,
  initializeTSViewer: initializeTSViewer,
  generateSelectorPanel: generateSelectorPanel,
  generateColorbarLegend: generateColorbarLegend,
  makePanel: makePanel,
  makeCheckbox: makeCheckbox,
  makeTextPanel: makeTextPanel,
  arrayRemove: arrayRemove,
  getAnnualNumOfObs: getAnnualNumOfObs
}



